#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();

function latestSummaryPath() {
  const logsDir = join(root, "validation-logs");
  if (!existsSync(logsDir)) return "";
  const candidates = readdirSync(logsDir)
    .map((name) => join(logsDir, name, "SUMMARY.csv"))
    .filter((path) => existsSync(path))
    .sort();
  return candidates.at(-1) ?? "";
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function positiveDelta(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isFailure(value) {
  return value === "FAIL";
}

function summarize(path) {
  const sourcePath = resolve(path);
  const text = readFileSync(sourcePath, "utf8").trim();
  if (!text) throw new Error(`SUMMARY.csv is empty: ${sourcePath}`);

  const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(headerLine);
  const expected = ["round", "timestamp", "guard", "sim", "live", "delta"];
  if (header.join(",") !== expected.join(",")) {
    throw new Error(`Unexpected SUMMARY.csv header: ${header.join(",")}`);
  }

  const rows = lines.map((line) => {
    const [round, timestamp, guard, sim, live, delta] = parseCsvLine(line);
    return { round: Number(round), timestamp, guard, sim, live, delta };
  });

  const statusCounts = { guard: {}, sim: {}, live: {} };
  let errors = 0;
  for (const row of rows) {
    for (const key of ["guard", "sim", "live"]) {
      const value = row[key];
      statusCounts[key][value] = (statusCounts[key][value] ?? 0) + 1;
      if (isFailure(value)) errors += 1;
    }
  }

  const firstDelta = rows.find((row) => positiveDelta(row.delta));
  const lastRow = rows.at(-1) ?? null;

  return {
    sourcePath,
    totalRounds: rows.length,
    errors,
    firstDeltaPositiveRound: firstDelta?.round ?? null,
    lastRound: lastRow?.round ?? null,
    lastTimestamp: lastRow?.timestamp ?? null,
    lastDelta: lastRow?.delta ?? null,
    statusCounts,
  };
}

const explicitPath = process.argv[2];
const path = explicitPath ? resolve(explicitPath) : latestSummaryPath();

if (!path) {
  console.error("No validation SUMMARY.csv found. Pass a path or run scripts/24h_validation.sh first.");
  process.exit(2);
}

try {
  console.log(JSON.stringify(summarize(path), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
