#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const out = {};
  const passthrough = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      passthrough.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? "true" : arg.slice(eq + 1);
    out[name] = value;
    if (!["k", "base-seed", "log-dir", "parallel", "port", "db-path"].includes(name)) passthrough.push(arg);
  }
  return { out, passthrough };
}

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function runNode(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code, signal) => resolveRun({ code: code ?? 1, signal: signal ?? null }));
  });
}

function reserveAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (Number.isInteger(port)) resolvePort(port);
        else rejectPort(new Error("Unable to reserve an ephemeral loopback port for pass^k seed run."));
      });
    });
  });
}

const { out: args, passthrough } = parseArgs(process.argv.slice(2));
const k = Math.max(1, Math.trunc(Number(args.k ?? 8)));
const baseSeed = Math.trunc(Number(args["base-seed"] ?? 1));
const logDir = resolve(args["log-dir"] || join(ROOT, "validation-logs", `passk_${timestampForPath()}`));
mkdirSync(logDir, { recursive: true });

const runs = [];
for (let index = 0; index < k; index += 1) {
  const seed = baseSeed + index;
  const runLogDir = join(logDir, `seed_${index}`);
  runs.push({
    index,
    seed,
    logDir: runLogDir,
    runId: `passk_seed_${index}`,
    port: await reserveAvailablePort(),
    dbPath: join(runLogDir, "shadow.db"),
  });
}

writeFileSync(join(logDir, "passk_manifest.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  k,
  baseSeed,
  runs,
}, null, 2)}\n`);

let failed = false;
for (const run of runs) {
  mkdirSync(run.logDir, { recursive: true });
  const runArgs = [
    "scripts/shadow-run.mjs",
    `--log-dir=${run.logDir}`,
    `--port=${run.port}`,
    `--db-path=${run.dbPath}`,
    `--seed=${run.seed}`,
    `--run-id=${run.runId}`,
    ...passthrough,
  ];
  console.error(`pass^k run ${run.index + 1}/${k}: seed=${run.seed} logDir=${run.logDir}`);
  const runner = await runNode(runArgs, {
    env: {
      ...process.env,
      PORT: String(run.port),
      ALAYA_DB_PATH: run.dbPath,
    },
  });
  if (runner.code !== 0) {
    failed = true;
    console.error(`pass^k seed ${run.seed} runner failed with code=${runner.code} signal=${runner.signal ?? ""}`);
    continue;
  }
  const analyzer = await runNode(["scripts/shadow-analyze.mjs", run.logDir]);
  if (analyzer.code !== 0) {
    console.error(`pass^k seed ${run.seed} analyzer exited code=${analyzer.code}; quality_summary.json may still have been written for aggregation.`);
  }
}

console.error(`pass^k logDir=${logDir}`);
process.exit(failed ? 1 : 0);
