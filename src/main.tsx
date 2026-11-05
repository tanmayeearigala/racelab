import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import type { Mode, Actor, TraceEvent, Result } from "../server/engine";

type Run = {
  id: string;
  mode: Mode;
  first_actor: Actor;
  status: string;
  waiting: boolean;
  events: TraceEvent[];
  result: Result | null;
};
const modes: Record<
  Mode,
  { name: string; tag: string; description: string; code: string }
> = {
  unsafe: {
    name: "Read, then write",
    tag: "UNSAFE",
    description:
      "Both buyers read the last ticket before either writes. A stale value turns one ticket into two confirmations.",
    code: "SELECT remaining FROM inventory;\n// Both requests see 1\nUPDATE inventory SET remaining = 0;\nINSERT INTO bookings (...);",
  },
  atomic: {
    name: "Atomic claim",
    tag: "FIX 01",
    description:
      "A conditional update and booking insert share one SQL statement. PostgreSQL rechecks the predicate after a competing update.",
    code: "WITH claimed AS (\n  UPDATE inventory\n  SET remaining = remaining - 1\n  WHERE remaining > 0 RETURNING id\n) INSERT INTO bookings\n  SELECT id FROM claimed;",
  },
  locked: {
    name: "Lock the row",
    tag: "FIX 02",
    description:
      "The first transaction holds a row lock. The second waits, then reads the committed inventory before deciding.",
    code: "BEGIN;\nSELECT remaining FROM inventory\n  FOR UPDATE;\n// Check availability, update, book\nCOMMIT;",
  },
};
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
function download(name: string, data: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const [mode, setMode] = useState<Mode>("unsafe"),
    [first, setFirst] = useState<Actor>("A"),
    [manual, setManual] = useState(true);
  const [run, setRun] = useState<Run | null>(null),
    [history, setHistory] = useState<Run[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(false);
  const refresh = () => api<Run[]>("/runs").then(setHistory);
  useEffect(() => {
    api("/health")
      .then(() => setOnline(true))
      .catch((e) => setError(e.message));
    refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!run || run.status !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await api<Run>("/runs/" + run.id);
        if (!cancelled) {
          setRun(next);
          if (next.status !== "running") await refresh();
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    const timer = setInterval(tick, 350);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);
  async function start() {
    setBusy(true);
    setError("");
    try {
      setRun(
        await api<Run>("/runs", {
          method: "POST",
          body: JSON.stringify({ mode, first, manual }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    setBusy(true);
    try {
      await api("/runs/" + run?.id + "/resume", { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function load(id: string) {
    try {
      const r = await api<Run>("/runs/" + id);
      setRun(r);
      setMode(r.mode);
      setFirst(r.first_actor);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const running = run?.status === "running",
    shown = run?.mode ?? mode,
    result = run?.result;
  const exportTest = () => {
    if (!run) return;
    download(
      "race-regression.test.mjs",
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nconst base = process.env.RACELAB_URL || 'http://127.0.0.1:3000';\ntest('reproduce ${run.mode} with first actor ${run.first_actor}', async () => {\n  const response = await fetch(base + '/api/runs', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:'${run.mode}', first:'${run.first_actor}', manual:false}) });\n  assert.equal(response.status, 201);\n  let run = await response.json();\n  for(let i=0; run.status === 'running' && i<200; i++) {\n    await new Promise(r=>setTimeout(r,100));\n    run = await (await fetch(base + '/api/runs/' + run.id)).json();\n  }\n  assert.equal(run.status,'completed');\n  assert.equal(run.result.bookings,${run.mode === "unsafe" ? 2 : 1});\n  assert.equal(run.result.passed,${run.mode !== "unsafe"});\n});\n`,
      "text/javascript",
    );
  };
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/" aria-label="RaceLab home">
          <span className="logo">R↗</span> RaceLab
          <span className="version">01</span>
        </a>
        <div className="navlabel">WORKSPACE</div>
        <div className="nav active">
          ◈ <span>Concurrency lab</span>
          <span>01</span>
        </div>
        <div className="aside-note">
          A small lab for
          <br />
          big consequences.
          <p>Real queries. Reproducible races. Observable fixes.</p>
        </div>
        <div className="db">
          <i className={online ? "dot" : "dot offline"} />
          <div>
            PostgreSQL
            <span>
              {online ? "Connected · local workspace" : "Connecting…"}
            </span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <span>
            EXPERIMENTS <b>/</b> DOUBLE BOOKING
          </span>
          <span className="local">
            LOCAL LAB <span>↗</span>
          </span>
        </header>
        <section className="hero">
          <div>
            <div className="eyebrow">BREAK IT. TRACE IT. FIX IT.</div>
            <h1>
              One ticket.
              <br />
              <em>Two confirmations?</em>
            </h1>
            <p>
              Make an invisible race condition visible. Control the requests,
              <br className="desktop" /> inspect the queries, and put the fix to
              the test.
            </p>
          </div>
          <div className="ticket">
            <div>
              LIVE EXPERIMENT <span>↗</span>
            </div>
            <strong>01</strong>
            <footer>
              TICKET AVAILABLE <span>●</span>
            </footer>
          </div>
        </section>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        <div className="workspace">
          <section className="config panel">
            <div className="section-title">
              <span className="step">01</span>
              <h2>Configure the race</h2>
            </div>
            <label className="label">IMPLEMENTATION</label>
            <div className="modes">
              {(Object.keys(modes) as Mode[]).map((m) => (
                <button
                  key={m}
                  disabled={running}
                  className={"mode " + (mode === m ? "selected" : "")}
                  onClick={() => setMode(m)}
                >
                  <span className="radio" />
                  <span>{modes[m].name}</span>
                  <small>{modes[m].tag}</small>
                </button>
              ))}
            </div>
            <p className="description">{modes[mode].description}</p>
            <label className="label" htmlFor="first">
              FIRST REQUEST {mode === "atomic" ? "(WINNER MAY VARY)" : ""}
            </label>
            <select
              id="first"
              value={first}
              disabled={running}
              onChange={(e) => setFirst(e.target.value as Actor)}
            >
              <option value="A">Buyer A → Buyer B</option>
              <option value="B">Buyer B → Buyer A</option>
            </select>
            <label className="toggle">
              <input
                type="checkbox"
                checked={manual}
                disabled={running}
                onChange={(e) => setManual(e.target.checked)}
              />
              <span>
                Pause at the critical moment
                <small>Auto-resumes after 30 seconds</small>
              </span>
            </label>
            <button
              className="primary"
              disabled={busy || running || !online}
              onClick={start}
            >
              {running ? "Experiment in progress…" : "Run experiment"}{" "}
              <span>↗</span>
            </button>
            <div className="code-title">
              THE APPROACH <span>PSEUDOCODE</span>
            </div>
            <pre className="code">{modes[mode].code}</pre>
          </section>
          <section className="trace panel">
            <div className="section-title">
              <span className="step">02</span>
              <h2>Execution trace</h2>
              <span className={"status " + (running ? "live" : "")}>
                {run ? run.status : "READY"}
              </span>
            </div>
            <div className="legend">
              <span>
                <i className="buyer a" /> BUYER A
              </span>
              <span>
                <i className="buyer b" /> BUYER B
              </span>
              <span>2 CONNECTIONS · 1 TICKET</span>
            </div>
            {run?.waiting && (
              <div className="checkpoint">
                <div>
                  <strong>Time is in your hands.</strong>
                  <span>
                    {shown === "locked"
                      ? "The second buyer is waiting on a real row lock."
                      : shown === "unsafe"
                        ? "Both buyers have read “1 available.” Release their writes."
                        : "Both buyers are ready to attempt an atomic claim."}
                  </span>
                </div>
                <button disabled={busy} onClick={resume}>
                  Release requests →
                </button>
              </div>
            )}
            <div className="events" aria-live="polite">
              {!run ? (
                <div className="empty">
                  <div className="empty-graphic">
                    <span>A</span>
                    <i>→</i>
                    <b>1</b>
                    <i>←</i>
                    <span>B</span>
                  </div>
                  <h3>The race starts here.</h3>
                  <p>
                    Run an experiment to follow each request
                    <br />
                    from its first read to its final commit.
                  </p>
                  <small>EVERY EVENT COMES FROM THE BACKEND</small>
                </div>
              ) : (
                run.events.map((e) => (
                  <div key={e.seq} className={"event " + e.kind}>
                    <span className="event-time">{e.elapsed_ms} ms</span>
                    <span className={"actor " + e.actor.toLowerCase()}>
                      {e.actor === "SYS" ? "◆" : e.actor}
                    </span>
                    <div>
                      <strong>
                        {e.kind === "query"
                          ? "Query dispatched"
                          : e.kind === "result"
                            ? "Database response"
                            : e.kind === "blocked"
                              ? "Waiting for row lock"
                              : e.kind === "pass"
                                ? "Invariant preserved"
                                : e.kind === "fail"
                                  ? "Double booking detected"
                                  : e.kind === "checkpoint"
                                    ? "Scheduler checkpoint"
                                    : e.kind === "rejected"
                                      ? "Booking declined"
                                      : "Scheduler"}
                      </strong>
                      {e.sql ? <code>{e.sql}</code> : <p>{e.message}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div
              className={
                "outcome " +
                (result ? (result.passed ? "success" : "failure") : "")
              }
            >
              <span>{result ? (result.passed ? "✓" : "!") : "="}</span>
              <div>
                <strong>
                  {result
                    ? result.passed
                      ? "One ticket. One booking."
                      : "One ticket. Two bookings."
                    : "The invariant we’re testing"}
                </strong>
                <p>
                  {result
                    ? `${result.bookings} confirmed · ${result.remaining} remaining · ${result.durationMs} ms (includes checkpoint)`
                    : "confirmed bookings + remaining tickets = 1"}
                </p>
              </div>
              <b>{result ? (result.passed ? "PASS" : "FAIL") : "≤ 1"}</b>
            </div>
          </section>
        </div>
        <section className="bottom">
          <div>
            <div className="section-title">
              <span className="step">03</span>
              <h2>Keep the evidence</h2>
            </div>
            <p>
              Export the trace or replay the same scenario as an executable
              test.
            </p>
          </div>
          <div className="actions">
            <button
              disabled={!run || running}
              onClick={() =>
                download("racelab-report.json", JSON.stringify(run, null, 2))
              }
            >
              ↓ JSON report
            </button>
            <button disabled={!result} onClick={exportTest}>
              ↓ Regression test
            </button>
          </div>
        </section>
        <section className="history panel">
          <div className="section-title">
            <h2>Recent experiments</h2>
            <span className="muted">LAST 30 RUNS</span>
          </div>
          {history.length === 0 ? (
            <p className="muted">
              Your completed experiments will appear here.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>RUN</th>
                    <th>IMPLEMENTATION</th>
                    <th>CONFIRMED</th>
                    <th>INVARIANT</th>
                    <th>ELAPSED*</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <code>{r.id.slice(0, 8)}</code>
                      </td>
                      <td>{modes[r.mode].name}</td>
                      <td>{r.result?.bookings ?? "—"}</td>
                      <td>
                        <span
                          className={
                            "badge " +
                            (r.result ? (r.result.passed ? "good" : "bad") : "")
                          }
                        >
                          {r.result
                            ? r.result.passed
                              ? "Preserved"
                              : "Violated"
                            : r.status}
                        </span>
                      </td>
                      <td>{r.result ? `${r.result.durationMs} ms` : "—"}</td>
                      <td>
                        <button disabled={running} onClick={() => load(r.id)}>
                          Inspect ↗
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <small className="footnote">
            * Includes scheduling and manual pauses. These are observations, not
            throughput benchmarks.
          </small>
        </section>
        <footer className="page-footer">
          <span>RACELAB / ENGINEERING YOU CAN EXPLAIN</span>
          <span>React · TypeScript · Node.js · PostgreSQL</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
