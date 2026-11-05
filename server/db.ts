import pg from "pg";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
async function control(binary: string, args: string[]) {
  // Wait for pg_ctl itself, not inherited stdout pipes held by PostgreSQL.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error("PostgreSQL control timed out; inspect .data/postgres.log"),
      );
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(`pg_ctl exited ${code}; inspect .data/postgres.log`),
          );
    });
  });
}

export async function openDatabase(
  port = Number(process.env.PGPORT || 55432),
  directory = ".data/postgres",
) {
  let stop: (() => Promise<void>) | undefined;
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    mkdirSync(resolve(directory, ".."), { recursive: true });
    // Use the platform binaries with pg_ctl so shutdown is graceful on Windows too.
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const binaries = await import(
      `@embedded-postgres/${platform}-${process.arch}`
    );
    const data = resolve(directory);
    if (!existsSync(resolve(data, "PG_VERSION"))) {
      const passwordFile = resolve(directory, "..", "init-password.txt");
      writeFileSync(passwordFile, "local-racelab");
      try {
        await exec(
          binaries.initdb,
          [
            "-D",
            data,
            "-U",
            "racelab",
            "--pwfile",
            passwordFile,
            "--auth=scram-sha-256",
            "--locale=C",
            "--encoding=UTF8",
          ],
          { timeout: 60000, windowsHide: true },
        );
      } finally {
        unlinkSync(passwordFile);
      }
    }
    await control(binaries.pg_ctl, [
      "-D",
      data,
      "-l",
      resolve(directory, "..", `postgres-${port}.log`),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ]);
    stop = async () => {
      await control(binaries.pg_ctl, ["-D", data, "-m", "fast", "-w", "stop"]);
    };
    connectionString = `postgresql://racelab:local-racelab@127.0.0.1:${port}/postgres`;
  }
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 45000,
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS race_runs (
    id uuid PRIMARY KEY, mode text NOT NULL, first_actor text NOT NULL, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), result jsonb);
    CREATE TABLE IF NOT EXISTS race_inventory (run_id uuid PRIMARY KEY REFERENCES race_runs(id), remaining integer NOT NULL CHECK(remaining >= 0));
    CREATE TABLE IF NOT EXISTS race_bookings (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id uuid NOT NULL REFERENCES race_runs(id), actor text NOT NULL);
    CREATE TABLE IF NOT EXISTS race_events (run_id uuid NOT NULL REFERENCES race_runs(id), seq integer NOT NULL, actor text NOT NULL, kind text NOT NULL, message text NOT NULL, sql text, elapsed_ms integer NOT NULL, PRIMARY KEY(run_id,seq));`);
  await pool.query(
    "UPDATE race_runs SET status='interrupted' WHERE status='running'",
  );
  return {
    pool,
    close: async () => {
      await pool.end();
      await stop?.();
    },
  };
}
