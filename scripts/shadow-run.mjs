#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
    if (eq === -1) out[arg.slice(2)] = "true";
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
    passthrough.push(arg);
  }
  return { out, passthrough };
}

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

const { out: args, passthrough } = parseArgs(process.argv.slice(2));
const durationHours = args["duration-hours"] ?? "24";
const logDir = resolve(args["log-dir"] || join(ROOT, "validation-logs", `shadow-24h_${timestampForPath()}`));
mkdirSync(logDir, { recursive: true });

const defaults = [
  `--duration-hours=${durationHours}`,
  "--sample-minutes=5",
  "--metrics-snapshot-minutes=30",
  "--watchdog-minutes=30",
  "--decision-via=local_api_human_proxy",
  "--hold-review-required-meaning-gates=false",
  `--log-dir=${logDir}`,
];

const suppliedNames = new Set(Object.keys(args));
const finalArgs = [
  "scripts/health-signal-36h-validation.mjs",
  ...defaults.filter((arg) => {
    const name = arg.slice(2, arg.indexOf("=") === -1 ? undefined : arg.indexOf("="));
    return !suppliedNames.has(name);
  }),
  ...passthrough,
];

if (args["print-command"] === "true") {
  console.log(JSON.stringify({ cwd: ROOT, command: process.execPath, args: finalArgs, logDir }, null, 2));
  process.exit(0);
}

console.error(`Shadow run starting. logDir=${logDir}`);
const child = spawn(process.execPath, finalArgs, {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
