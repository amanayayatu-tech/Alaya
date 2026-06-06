import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { rawDb } from "../storage";
import { runModeFromEnv, validateEnv } from "../config/env";

function writable(path: string): { ok: boolean; message: string } {
  try {
    accessSync(path, constants.W_OK);
    return { ok: true, message: "writable" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function configuredWritableDirs(): string[] {
  const dbDir = dirname(resolve(process.env.ALAYA_DB_PATH ?? "data.db"));
  return Array.from(new Set([
    dbDir,
    process.env.ALAYA_DATA_DIR,
    process.env.ALAYA_LOG_DIR,
    process.env.ALAYA_STATE_DIR,
    process.env.ALAYA_CACHE_DIR,
  ].filter((item): item is string => !!item && item.trim().length > 0)));
}

export function buildHealthz() {
  return {
    status: "ok",
    mode: runModeFromEnv(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

export function buildReadyz() {
  const env = validateEnv();
  const checks: Record<string, { ok: boolean; message: string }> = {
    config: {
      ok: env.errors.length === 0,
      message: env.errors.length === 0 ? "valid" : env.errors.join("; "),
    },
    database: { ok: false, message: "" },
  };

  try {
    rawDb.prepare("SELECT 1 AS ok").get();
    checks.database = { ok: true, message: "reachable" };
  } catch (error) {
    checks.database = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  for (const dir of configuredWritableDirs()) {
    checks[`writable:${dir}`] = writable(dir);
  }

  const ready = Object.values(checks).every((check) => check.ok);
  return {
    status: ready ? "ready" : "not_ready",
    mode: env.mode,
    checks,
    timestamp: new Date().toISOString(),
  };
}
