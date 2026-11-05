import express from "express";
import type { Pool } from "pg";
import { Experiment, type Actor, type Mode } from "./engine.js";

export function createApp(pool: Pool) {
  const app = express();
  let active: Experiment | undefined;
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // The local demo has no accounts; reject cross-origin browser mutations.
    const origin = req.headers.origin;
    if (
      req.method === "POST" &&
      origin &&
      origin !== `http://${req.headers.host}`
    ) {
      res.status(403).json({ error: "Cross-origin writes are disabled" });
      return;
    }
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "PostgreSQL" });
  });
  app.get("/api/runs", async (_req, res) => {
    res.json(
      (
        await pool.query(
          "SELECT * FROM race_runs ORDER BY created_at DESC LIMIT 30",
        )
      ).rows,
    );
  });
  app.post("/api/runs", async (req, res) => {
    const { mode, first = "A", manual = true } = req.body ?? {};
    if (
      !["unsafe", "atomic", "locked"].includes(mode) ||
      !["A", "B"].includes(first) ||
      typeof manual !== "boolean"
    ) {
      res
        .status(400)
        .json({
          error:
            "Expected mode: unsafe|atomic|locked, first: A|B, manual: boolean",
        });
      return;
    }
    if (active?.status === "running") {
      res
        .status(409)
        .json({ error: "Finish the active experiment first", id: active.id });
      return;
    }
    const experiment = new Experiment(
      pool,
      mode as Mode,
      first as Actor,
      manual,
    );
    active = experiment;
    try {
      await experiment.start();
      experiment.done.catch(console.error);
      res.status(201).json(experiment.snapshot());
    } catch (e) {
      active = undefined;
      throw e;
    }
  });
  app.get("/api/runs/:id", async (req, res) => {
    if (active?.id === req.params.id) {
      res.json(active.snapshot());
      return;
    }
    const run = (
      await pool.query("SELECT * FROM race_runs WHERE id::text=$1", [
        req.params.id,
      ])
    ).rows[0];
    if (!run) {
      res.status(404).json({ error: "Experiment not found" });
      return;
    }
    const events = (
      await pool.query(
        "SELECT seq,actor,kind,message,sql,elapsed_ms FROM race_events WHERE run_id=$1 ORDER BY seq",
        [run.id],
      )
    ).rows;
    res.json({ ...run, events, waiting: false });
  });
  app.post("/api/runs/:id/resume", (req, res) => {
    if (active?.id !== req.params.id || !active.resume()) {
      res.status(409).json({ error: "This experiment is not paused" });
      return;
    }
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found" }),
  );
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(error);
      res
        .status(error.status ?? 500)
        .json({
          error:
            error.status === 400
              ? "Invalid JSON body"
              : "Request failed; inspect the server log.",
        });
    },
  );
  return {
    app,
    finish: async () => {
      if (active) {
        active.resume();
        await active.done;
      }
    },
  };
}
