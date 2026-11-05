import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type Mode = "unsafe" | "atomic" | "locked";
export type Actor = "A" | "B";
export type TraceEvent = {
  seq: number;
  actor: string;
  kind: string;
  message: string;
  sql?: string;
  elapsed_ms: number;
};
export type Result = {
  bookings: number;
  remaining: number;
  passed: boolean;
  durationMs: number;
  winners: string[];
};
type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

export class Experiment {
  id = randomUUID();
  events: TraceEvent[] = [];
  status = "running";
  result: Result | null = null;
  waiting = false;
  done: Promise<void> = Promise.resolve();
  private checkpoint = gate();
  private started = performance.now();
  private released = false;
  constructor(
    private pool: Pool,
    public mode: Mode,
    public first: Actor,
    private manual: boolean,
  ) {}
  resume() {
    if (!this.waiting) return false;
    this.released = true;
    this.checkpoint.release();
    return true;
  }
  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      first_actor: this.first,
      status: this.status,
      waiting: this.waiting,
      events: this.events,
      result: this.result,
    };
  }
  private emit(actor: string, kind: string, message: string, sql?: string) {
    this.events.push({
      seq: this.events.length + 1,
      actor,
      kind,
      message,
      sql,
      elapsed_ms: Math.round(performance.now() - this.started),
    });
  }
  private async pause() {
    this.waiting = true;
    this.emit(
      "SYS",
      "checkpoint",
      "Checkpoint reached. Release the requests to continue.",
    );
    const timer = setTimeout(() => this.checkpoint.release(), 30000);
    if (!this.manual) this.checkpoint.release();
    await this.checkpoint.promise;
    clearTimeout(timer);
    this.waiting = false;
    this.emit(
      "SYS",
      "resume",
      this.manual && !this.released
        ? "30-second checkpoint timeout; automatically resumed."
        : "Scheduler released the checkpoint.",
    );
  }
  private async query(
    c: PoolClient,
    actor: Actor,
    sql: string,
    params: unknown[] = sql.includes("$1") ? [this.id] : [],
  ) {
    this.emit(actor, "query", "SQL submitted", sql);
    const result = await c.query(sql, params);
    this.emit(
      actor,
      "result",
      result.rows.length
        ? JSON.stringify(result.rows)
        : result.rowCount === null ? 'Command completed' : `${result.rowCount} row(s) affected`,
    );
    return result;
  }
  async start() {
    await this.pool.query(
      "INSERT INTO race_runs(id,mode,first_actor,status) VALUES($1,$2,$3,$4)",
      [this.id, this.mode, this.first, "running"],
    );
    await this.pool.query("INSERT INTO race_inventory VALUES($1,1)", [this.id]);
    this.done = this.execute();
    return this;
  }
  private async execute() {
    let a: PoolClient | undefined, b: PoolClient | undefined;
    let finalStatus = "failed";
    const first = this.first,
      second: Actor = first === "A" ? "B" : "A";
    try {
      a = await this.pool.connect();
      b = await this.pool.connect();
      this.emit(
        "SYS",
        "start",
        "Two independent PostgreSQL connections. One available ticket.",
      );
      if (this.mode === "unsafe") {
        const read = "SELECT remaining FROM race_inventory WHERE run_id=$1";
        const x = await this.query(a, first, read);
        const y = await this.query(b, second, read);
        await this.pause();
        for (const [client, actor, observed] of [
          [a, first, x.rows[0].remaining],
          [b, second, y.rows[0].remaining],
        ] as const) {
          if (observed > 0) {
            await this.query(
              client,
              actor,
              "UPDATE race_inventory SET remaining=$2 WHERE run_id=$1",
              [this.id, observed - 1],
            );
            await this.query(
              client,
              actor,
              "INSERT INTO race_bookings(run_id,actor) VALUES($1,$2)",
              [this.id, actor],
            );
          }
        }
      } else if (this.mode === "atomic") {
        await this.pause();
        // Both statements execute on independent connections; winner is deliberately unspecified.
        await Promise.all(
          [
            [a, first],
            [b, second],
          ].map(async ([client, actor]) => {
            await this.query(
              client as PoolClient,
              actor as Actor,
              `WITH claimed AS (UPDATE race_inventory SET remaining=remaining-1 WHERE run_id=$1 AND remaining>0 RETURNING run_id) INSERT INTO race_bookings(run_id,actor) SELECT run_id,$2 FROM claimed RETURNING actor`,
              [this.id, actor],
            );
          }),
        );
      } else {
        await this.query(a, first, "BEGIN");
        await this.query(
          a,
          first,
          "SELECT remaining FROM race_inventory WHERE run_id=$1 FOR UPDATE",
        );
        await this.query(b, second, "BEGIN");
        const pending = this.query(
          b,
          second,
          "SELECT remaining FROM race_inventory WHERE run_id=$1 FOR UPDATE",
        );
        // Attach a handler immediately: a query timeout must never become an unhandled rejection.
        const settled = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        // Observe a real PostgreSQL lock wait, rather than inferring it from a delay.
        const pid = (
          await this.pool.query(
            "SELECT pid FROM pg_stat_activity WHERE pid=$1",
            [(b as unknown as { processID: number }).processID],
          )
        ).rows[0]?.pid;
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const r = await this.pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (r.rows[0]?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        if (!blocked)
          throw new Error("Could not observe the expected database lock wait");
        this.emit(
          second,
          "blocked",
          "PostgreSQL reports wait_event_type = Lock. Waiting for the first transaction.",
        );
        // Connection statement timeout (45s) exceeds the 30s teaching checkpoint.
        await this.pause();
        await this.query(
          a,
          first,
          "UPDATE race_inventory SET remaining=remaining-1 WHERE run_id=$1",
        );
        await this.query(
          a,
          first,
          "INSERT INTO race_bookings(run_id,actor) VALUES($1,$2)",
          [this.id, first],
        );
        await this.query(a, first, "COMMIT");
        const outcome = await settled;
        if ("error" in outcome) throw outcome.error;
        if (outcome.value.rows[0].remaining === 0)
          this.emit(
            second,
            "rejected",
            "Fresh locked read sees 0 tickets. Booking rejected.",
          );
        await this.query(b, second, "COMMIT");
      }
      const count = await this.pool.query(
        "SELECT actor FROM race_bookings WHERE run_id=$1 ORDER BY id",
        [this.id],
      );
      const inventory = await this.pool.query(
        "SELECT remaining FROM race_inventory WHERE run_id=$1",
        [this.id],
      );
      const bookings = count.rowCount!,
        remaining = inventory.rows[0].remaining;
      this.result = {
        bookings,
        remaining,
        passed: bookings <= 1 && bookings + remaining === 1,
        durationMs: Math.round(performance.now() - this.started),
        winners: count.rows.map((r) => r.actor),
      };
      finalStatus = "completed";
      this.emit(
        "SYS",
        this.result.passed ? "pass" : "fail",
        this.result.passed
          ? "Invariant holds: bookings + remaining = 1."
          : "Invariant violated: two confirmations for one ticket.",
      );
    } catch (error) {
      this.waiting = false;
      this.emit(
        "SYS",
        "error",
        error instanceof Error ? error.message : "Execution failed",
      );
      await Promise.allSettled([a?.query("ROLLBACK"), b?.query("ROLLBACK")]);
    } finally {
      a?.release();
      b?.release();
      for (const e of this.events)
        await this.pool.query(
          "INSERT INTO race_events VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            this.id,
            e.seq,
            e.actor,
            e.kind,
            e.message,
            e.sql ?? null,
            e.elapsed_ms,
          ],
        );
      await this.pool.query(
        "UPDATE race_runs SET status=$2,result=$3 WHERE id=$1",
        [this.id, finalStatus, this.result],
      );
      this.status = finalStatus;
    }
  }
}
