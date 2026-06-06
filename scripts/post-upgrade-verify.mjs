#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const baseUrl = process.env.ALAYA_BASE_URL || process.env.ALAYA_E2E_BASE_URL || "";

async function probe(path) {
  if (!baseUrl) return { path, status: "skipped", reason: "ALAYA_BASE_URL not set" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`);
    return { path, status: response.ok ? "ok" : "fail", httpStatus: response.status };
  } catch (error) {
    return { path, status: "fail", reason: error instanceof Error ? error.message : String(error) };
  }
}

const commands = [
  ["npm", ["run", "guard"]],
  ["npm", ["--prefix", "alaya-core", "test"]],
];

const commandResults = commands.map(([cmd, args]) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { command: [cmd, ...args].join(" "), status: result.status === 0 ? "ok" : "fail" };
});

const probes = [await probe("/healthz"), await probe("/readyz"), await probe("/metrics")];
const failed = [...commandResults, ...probes].filter((item) => item.status === "fail");
console.log(JSON.stringify({ status: failed.length ? "fail" : "ok", commandResults, probes }, null, 2));
if (failed.length) process.exit(1);
