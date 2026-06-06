#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(new URL("../alaya-app/package.json", import.meta.url));
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length) ||
  (args.includes("--out") ? args[args.indexOf("--out") + 1] : "") ||
  "";
const dbPath = resolve(root, process.env.ALAYA_DB_PATH || "alaya-app/data.db");

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

const actionRows = all("SELECT status, action_type, risk_level, payload FROM action_ledger ORDER BY created_at ASC");
const denied = actionRows.filter((row) => row.status === "blocked");
const dryRun = actionRows.filter((row) => row.status === "dry_run");
const llm = one("SELECT COUNT(*) AS count, COALESCE(SUM(token_count),0) AS tokens, COALESCE(SUM(estimated_cost),0) AS cost FROM llm_calls");
const errors = all("SELECT ts, actor, table_name, op, after FROM event_log WHERE op='error' OR op='sync_error' ORDER BY id DESC LIMIT 20");

const report = [
  "# Alaya Shadow Run Report",
  "",
  `Generated at: ${new Date().toISOString()}`,
  `Database: ${dbPath}`,
  "",
  "## Summary",
  "",
  `- Action ledger rows: ${actionRows.length}`,
  `- Dry-run actions: ${dryRun.length}`,
  `- Denied actions: ${denied.length}`,
  `- LLM calls: ${llm.count}`,
  `- LLM tokens: ${llm.tokens}`,
  `- Estimated LLM cost USD: ${Number(llm.cost).toFixed(6)}`,
  `- Recent error events: ${errors.length}`,
  "",
  "## Denied Or Dry-Run Capability Actions",
  "",
  ...[...dryRun, ...denied].slice(-50).map((row) => `- ${row.status} ${row.action_type} ${row.risk_level}`),
  "",
  "## Recent Errors",
  "",
  ...errors.map((row) => `- ${row.ts} ${row.actor} ${row.table_name}.${row.op}`),
  "",
].join("\n");

if (outArg) {
  const out = resolve(outArg);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  console.log(JSON.stringify({ status: "ok", out }, null, 2));
} else {
  console.log(report);
}
