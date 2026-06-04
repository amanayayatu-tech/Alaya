#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const cycleId = argValue("--cycle");
const projectId = argValue("--project");
const limit = Number(argValue("--limit") ?? 1000);

if (!cycleId && !projectId) {
  console.error("Usage: npm run trace:export -- --cycle <cycleId> OR --project <projectId> [--limit 1000]");
  process.exit(1);
}

if (!process.env.ALAYA_DB_PATH) {
  const candidates = [
    resolve(process.cwd(), "data.db"),
    resolve(process.cwd(), "alaya-app/data.db"),
  ];
  process.env.ALAYA_DB_PATH = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
process.env.ALAYA_LLM_PROVIDER ??= "mock";

const { storage } = await import("../alaya-app/server/storage.ts");
const { parseTraceEvent } = await import("../alaya-app/server/trace.ts");

const rows = cycleId
  ? storage.listTraceEventsByCycle(cycleId, limit)
  : storage.listTraceEventsByProject(projectId, limit);

for (const row of rows) {
  process.stdout.write(`${JSON.stringify(parseTraceEvent(row))}\n`);
}
