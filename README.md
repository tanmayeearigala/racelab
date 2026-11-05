# RaceLab

**One ticket. Two confirmations?** A full-stack concurrency lab that reproduces a double-booking bug against real PostgreSQL, exposes the SQL trace, and compares two fixes.

Built with React, TypeScript, Node.js, Express, and PostgreSQL. The default setup starts a real local PostgreSQL process through `embedded-postgres`; Docker is optional. There is no simulated database or invented performance data.

## Run locally

Requires Node.js 22+ and npm. From this directory:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000. First start initializes `.data/postgres`. PostgreSQL listens on loopback port 55432; the web app listens on loopback port 3000. Stop with Ctrl+C. The development database and history persist. The embedded launcher is a beta dependency, pinned in the lockfile; it downloads platform binaries during installation. Linux must run PostgreSQL as a non-root user.

For a built frontend:

```sh
npm run build
npm start
```

If `dist/` exists, the server serves that build. Remove `dist/` or rebuild after frontend edits. The backend runs TypeScript via tsx.

## The two-minute demo

1. Select **Read, then write**, keep the checkpoint enabled, and run.
2. Notice both independent connections read `remaining = 1`. No booking has been written yet.
3. Release requests. Both insert confirmations, although only one ticket existed. The inventory counter alone still looks plausible at zero.
4. Select **Atomic claim** and rerun. The conditional update and booking insert form a single statement. Exactly one request wins.
5. Select **Lock the row**. The first transaction locks the row. The server checks `pg_stat_activity` and displays the second connection's actual `Lock` wait. Release to commit, then watch the second buyer read zero and decline.
6. Reverse the first buyer for the unsafe and locking schedules. For atomic mode, the winner is intentionally unspecified: correctness must not depend on who wins.
7. Download the JSON report and executable regression test. With the app running, execute the exported file using `node --test race-regression.test.mjs`.

Manual checkpoints resume after 30 seconds. Elapsed times include human pause time and instrumentation; they are **not** throughput benchmarks.

## Validate

```sh
npm run check
npm test
npm run build
```

Integration tests start a separate real PostgreSQL cluster on port 55433 in `.data/test-postgres`. They test both buyer orders, database persistence, observed lock waits, manual checkpoint release, repeated atomic contention, API validation, cross-origin rejection, and active-run conflict handling.

With the app running, browser verification is also available: `npx playwright install chromium` followed by `node tests/browser.mjs`. It checks all three flows, exports, and mobile page overflow, and saves screenshots under `test-results/`.

Do not point the app or tests at a production database. To use your own isolated PostgreSQL database, set `DATABASE_URL`. The app creates four `race_*` tables. The optional Compose file supplies a development database:

```sh
docker compose up -d
```

PowerShell:

```powershell
$env:DATABASE_URL='postgresql://racelab:local-racelab@127.0.0.1:55434/racelab'
npm run dev
```

## Architecture

```text
React UI ── REST + 350ms polling ── Express API
                                       │
                             Experiment coordinator
                          checkpoint / release / trace
                                 │           │
                             connection A  connection B
                                 └──── PostgreSQL ────┘
                                   inventory, bookings,
                                   runs, execution events
```

`server/engine.ts` is the experiment coordinator and database implementation. `server/app.ts` validates requests and serializes experiments. `server/db.ts` manages the database and schema. `src/main.tsx` implements the interactive lab; `tests/engine.test.ts` verifies the behavior through SQL and HTTP.

Each run gets an isolated inventory row keyed by UUID. One active experiment is accepted per server process. A checkpoint deterministically forces the unsafe read/read/write/write ordering. Locked mode forces the first lock acquisition, observes contention, then releases it. Atomic mode submits competing SQL statements without imposing a winning buyer.

## Why the fixes work

| Approach         | Behavior                                                                        | Tradeoff                                                                    |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Read, then write | Availability is checked outside the write. Two stale reads permit two bookings. | Simple code, incorrect under the forced interleaving.                       |
| Atomic claim     | Conditional decrement plus booking insert in one CTE statement.                 | Compact and atomic; fits a single SQL-encodable decision.                   |
| Row lock         | `SELECT … FOR UPDATE` inside a transaction, then check and book.                | Flexible multi-step logic; holds a lock while the transaction remains open. |

The unsafe path deliberately writes the previously read value minus one. That produces a lost update: the counter is zero but two booking rows exist. A `remaining >= 0` check alone does not catch this. The tested invariant is `bookings + remaining = initial capacity`, with bookings no greater than capacity.

PostgreSQL's default READ COMMITTED isolation allows the stale-read schedule. In the atomic implementation, the competing UPDATE re-evaluates `remaining > 0` after waiting for a conflicting writer. In the locking implementation, the second locked read observes the first transaction's committed update.

## API

| Endpoint                    | Purpose                       |
| --------------------------- | ----------------------------- |
| `GET /api/health`           | Database connectivity         |
| `POST /api/runs`            | Start `{mode: "unsafe"        | "atomic" | "locked", first: "A" | "B", manual: true | false}` |
| `GET /api/runs/:id`         | Run status, trace, and result |
| `POST /api/runs/:id/resume` | Release the manual checkpoint |
| `GET /api/runs`             | Latest 30 runs                |

## Deliberate boundaries

- This is a local educational developer tool, not a ticket-selling service. It has no login or multi-tenant security and binds to loopback. Do not expose it publicly without authentication, TLS, quotas, and authorization.
- Reproducibility applies to these instrumented scenarios; this is not a debugger for arbitrary applications.
- Live traces are held in memory and persisted at the end. A process crash can lose the current trace. On startup, incomplete runs are marked interrupted.
- Exactly one application process should own a database. Admission control is in memory; multiple replicas would need a database-backed lease.
- Tests demonstrate the chosen schedules and repeated contention; they do not prove correctness under every possible failure or workload.
- The regression-test export reruns the configuration and checks the expected outcome. It does not replay exact timing or force a particular atomic winner.
- The SQL snippets in the configuration panel are pseudocode. Full executed SQL is in the trace, with positional parameters rather than interpolated values.

## Resume and interview material

After you run, understand, and customize the project, an accurate bullet is:

> Built a React/TypeScript concurrency debugging lab using Node.js and PostgreSQL; reproduced double-booking through controlled request interleavings and validated atomic SQL and row-locking fixes with integration tests.

Discuss why a nonnegative inventory constraint is insufficient, why application mutexes fail across replicas, why a row lock needs a transaction, and why elapsed time with a manual checkpoint is not a performance benchmark. Never add scale or latency claims without measuring them.

Strong next extensions: idempotency-key collisions with a unique constraint, a retryable serialization failure scenario, CI artifacts containing traces, and load measurements with checkpoint pauses disabled. Keep them separate from the demonstrated first release.

## References

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [node-postgres transactions: use one client per transaction](https://node-postgres.com/features/transactions)
- [Embedded PostgreSQL launcher](https://github.com/leinelissen/embedded-postgres)
