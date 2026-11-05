import { openDatabase } from "./db.js";
import { createApp } from "./app.js";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const db = await openDatabase();
const { app, finish } = createApp(db.pool);
let vite:
  Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (existsSync("dist/index.html")) {
  app.use(express.static("dist"));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
  console.log("RaceLab is ready: http://127.0.0.1:3000"),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  await finish();
  await vite?.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
