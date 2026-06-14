#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = "true";
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function seedFromDirName(path) {
  const match = /^seed_(\d+)(?:_|$)/.exec(basename(path));
  return match ? Number(match[1]) : null;
}

function expectedRuns(logDir, explicitK) {
  const manifest = readJson(join(logDir, "passk_manifest.json"), null);
  if (Array.isArray(manifest?.runs) && manifest.runs.length > 0) {
    return manifest.runs.map((run, index) => ({
      index,
      seed: Number.isFinite(Number(run.seed)) ? Number(run.seed) : seedFromDirName(run.logDir ?? "") ?? index,
      logDir: resolve(logDir, run.logDir ? String(run.logDir) : `seed_${index}`),
    }));
  }
  const seedDirs = existsSync(logDir)
    ? readdirSync(logDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^seed_\d+/.test(entry.name))
      .map((entry) => resolve(logDir, entry.name))
      .sort()
    : [];
  const k = Math.max(0, Math.trunc(Number(explicitK ?? seedDirs.length)));
  return Array.from({ length: k }, (_, index) => {
    const discovered = seedDirs[index] ?? resolve(logDir, `seed_${index}`);
    return {
      index,
      seed: seedFromDirName(discovered) ?? index,
      logDir: discovered,
    };
  });
}

export function aggregatePassK({ logDir, k = null } = {}) {
  const resolvedLogDir = resolve(logDir || "");
  const runs = expectedRuns(resolvedLogDir, k);
  const perSeed = runs.map((run) => {
    const qualityPath = join(run.logDir, "quality_summary.json");
    const summary = readJson(qualityPath, null);
    const decision = summary?.decisionTsr ?? null;
    const passed = decision?.status === "pass" || decision?.passed === true;
    return {
      seed: run.seed,
      logDir: run.logDir,
      qualitySummaryPath: existsSync(qualityPath) ? qualityPath : null,
      decisionTsrStatus: decision?.status ?? null,
      passed: summary ? passed : false,
      complete: Boolean(summary),
      missingReason: summary ? null : "missing_quality_summary",
    };
  });
  const completed = perSeed.filter((run) => run.complete);
  const passedCount = perSeed.filter((run) => run.passed).length;
  const expectedK = runs.length;
  const passAt1 = expectedK === 0 ? null : +(passedCount / expectedK).toFixed(6);
  const passPowK = expectedK === 0 ? null : (completed.length === expectedK && passedCount === expectedK ? 1 : 0);
  const thresholds = { passAt1: 0.85, passPowK: 0.6 };
  let status = "incomplete";
  if (expectedK > 0 && completed.length === expectedK) {
    status = passAt1 >= thresholds.passAt1 && passPowK >= thresholds.passPowK ? "pass" : "fail";
  }
  return {
    generatedAt: new Date().toISOString(),
    logDir: resolvedLogDir,
    k: expectedK,
    completed: completed.length,
    passed: passedCount,
    perSeed,
    passAt1,
    passPowK,
    thresholds,
    status,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logDir = args["log-dir"];
  if (!logDir) {
    console.error("Usage: node scripts/passk-aggregate.mjs --log-dir=validation-logs/passk_<ts> [--k=8]");
    process.exit(2);
  }
  const summary = aggregatePassK({ logDir, k: args.k == null ? null : Number(args.k) });
  const outputPath = join(resolve(logDir), "passk_summary.json");
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(outputPath);
  process.exit(summary.status === "pass" ? 0 : 1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
