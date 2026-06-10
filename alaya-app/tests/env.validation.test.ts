import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  validateEnv,
  isSchemaMigrationAllowed,
  reviewWindowsFromEnv,
  reviewTimezoneFromEnv,
  gateEscalationMissedWindowsFromEnv,
  immediateRiskLevelsFromEnv,
} = await import("../server/config/env.ts");

test("production fails fast without a configured database path", () => {
  const result = validateEnv({
    NODE_ENV: "production",
    ALAYA_MODE: "production",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
  } as NodeJS.ProcessEnv);
  assert.equal(result.mode, "production");
  assert.ok(result.errors.some((error) => error.includes("ALAYA_DB_PATH")));
});

test("long-run modes require an API key", () => {
  for (const mode of ["shadow", "staging", "production"]) {
    const result = validateEnv({
      NODE_ENV: mode === "production" ? "production" : "development",
      ALAYA_MODE: mode,
      ...(mode === "shadow" ? {} : { ALAYA_DB_PATH: "/var/lib/alaya/alaya.db" }),
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
    } as NodeJS.ProcessEnv);
    assert.ok(result.errors.some((error) => error.includes("ALAYA_API_KEY")), `${mode} should require ALAYA_API_KEY`);
  }
});

test("long-run modes reject demo seed", () => {
  for (const mode of ["shadow", "staging"] as const) {
    const result = validateEnv({
      NODE_ENV: "development",
      ALAYA_MODE: mode,
      ALAYA_API_KEY: `unit-api-key-for-${mode}-seed-check`,
      ...(mode === "shadow" ? {} : { ALAYA_DB_PATH: "/var/lib/alaya/alaya.db" }),
      ALAYA_AUTO_SEED_DEMO: "true",
      ALAYA_LLM_PROVIDER: "mock",
    } as NodeJS.ProcessEnv);
    assert.ok(
      result.errors.some((error) => error.includes("ALAYA_AUTO_SEED_DEMO=false")),
      `${mode} should reject demo seed`,
    );
  }
});

test("local modes allow demo seed for fixtures", () => {
  for (const mode of ["development", "test"] as const) {
    const result = validateEnv({
      NODE_ENV: mode === "test" ? "test" : "development",
      ALAYA_MODE: mode,
      ALAYA_AUTO_SEED_DEMO: "true",
      ALAYA_LLM_PROVIDER: "mock",
    } as NodeJS.ProcessEnv);
    assert.ok(
      !result.errors.some((error) => error.includes("ALAYA_AUTO_SEED_DEMO")),
      `${mode} should not require ALAYA_AUTO_SEED_DEMO=false`,
    );
  }
});

test("production rejects obvious placeholder secrets", () => {
  const result = validateEnv({
    NODE_ENV: "production",
    ALAYA_MODE: "production",
    ALAYA_DB_PATH: "/var/lib/alaya/alaya.db",
    ALAYA_API_KEY: "unit-api-key-for-valid-prod-config",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
    ALAYA_WEBHOOK_SECRET: "changeme",
  } as NodeJS.ProcessEnv);
  assert.ok(result.errors.some((error) => error.includes("ALAYA_WEBHOOK_SECRET")));
});

test("shadow and production require explicit schema migration capability", () => {
  assert.equal(isSchemaMigrationAllowed({ ALAYA_MODE: "shadow" } as NodeJS.ProcessEnv), false);
  assert.equal(isSchemaMigrationAllowed({ ALAYA_MODE: "shadow", ALAYA_CAP_DATABASE_MIGRATION: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(isSchemaMigrationAllowed({ ALAYA_MODE: "development" } as NodeJS.ProcessEnv), true);
});

test("valid production mock configuration passes core checks", () => {
  const result = validateEnv({
    NODE_ENV: "production",
    ALAYA_MODE: "production",
    ALAYA_DB_PATH: "/var/lib/alaya/alaya.db",
    ALAYA_API_KEY: "unit-api-key-for-valid-prod-config",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
    ALAYA_REVIEW_TIMEZONE: "Asia/Shanghai",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(result.errors, []);
});

test("review window env validates windows, timezone, and missed-window threshold", () => {
  const valid = validateEnv({
    ALAYA_MODE: "shadow",
    ALAYA_DB_PATH: "/var/lib/alaya/alaya.db",
    ALAYA_API_KEY: "unit-api-key-for-shadow-window-config",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
    ALAYA_REVIEW_TIMEZONE: "Asia/Shanghai",
    ALAYA_REVIEW_WINDOWS: "09:00-09:15,15:30-16:00",
    ALAYA_GATE_ESCALATION_MISSED_WINDOWS: "3",
    ALAYA_APPLY_GRACE_SECONDS: "0",
    ALAYA_APPLY_STAGGER_SECONDS: "30",
    ALAYA_SPECULATIVE_BUDGET_RATIO: "0.75",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(valid.errors, []);
  assert.equal(reviewWindowsFromEnv({ ALAYA_REVIEW_WINDOWS: "09:00-09:15" } as NodeJS.ProcessEnv)[0].label, "09:00-09:15");
  assert.equal(reviewTimezoneFromEnv({} as NodeJS.ProcessEnv), "Asia/Shanghai");
  assert.equal(gateEscalationMissedWindowsFromEnv({ ALAYA_GATE_ESCALATION_MISSED_WINDOWS: "3" } as NodeJS.ProcessEnv), 3);
  assert.equal(immediateRiskLevelsFromEnv({ ALAYA_IMMEDIATE_RISK_LEVELS: "financial, destructive" } as NodeJS.ProcessEnv).has("destructive"), true);

  const invalid = validateEnv({
    ALAYA_MODE: "shadow",
    ALAYA_DB_PATH: "/var/lib/alaya/alaya.db",
    ALAYA_API_KEY: "unit-api-key-for-shadow-window-config",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
    ALAYA_REVIEW_WINDOWS: "16:00-15:30",
    ALAYA_REVIEW_TIMEZONE: "Not/AZone",
    ALAYA_GATE_ESCALATION_MISSED_WINDOWS: "0",
    ALAYA_SPECULATIVE_BUDGET_RATIO: "1.5",
  } as NodeJS.ProcessEnv);
  assert.ok(invalid.errors.some((error) => error.includes("ALAYA_REVIEW_WINDOWS")));
  assert.ok(invalid.errors.some((error) => error.includes("ALAYA_REVIEW_TIMEZONE")));
  assert.ok(invalid.errors.some((error) => error.includes("ALAYA_GATE_ESCALATION_MISSED_WINDOWS")));
  assert.ok(invalid.errors.some((error) => error.includes("ALAYA_SPECULATIVE_BUDGET_RATIO")));
});

test("external notification requires numeric Telegram user id", () => {
  const result = validateEnv({
    ALAYA_CAP_EXTERNAL_NOTIFICATION: "true",
    ALAYA_TELEGRAM_USER_ID: "owner",
  } as NodeJS.ProcessEnv);
  assert.ok(result.errors.some((error) => error.includes("ALAYA_TELEGRAM_USER_ID")));
});

test("storage import fails fast on invalid production env before opening the default DB", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--eval",
    "await import('./server/storage.ts')",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ALAYA_MODE: "production",
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
      ALAYA_DB_PATH: "",
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /ALAYA_DB_PATH is required/);
});

test("long-run storage import requires initialized schema but not an open migration window", () => {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-steady-schema-"));
  const dbPath = join(tmp, "ready.db");
  const cwd = new URL("..", import.meta.url);
  const migrate = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--eval",
    "await import('./server/storage.ts')",
  ], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ALAYA_MODE: "development",
      ALAYA_DB_PATH: dbPath,
      ALAYA_LLM_PROVIDER: "mock",
      ALAYA_REVIEW_TIMEZONE: "Asia/Shanghai",
    },
    encoding: "utf8",
  });
  assert.equal(migrate.status, 0, migrate.stderr + migrate.stdout);

  const steady = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--eval",
    "await import('./server/storage.ts')",
  ], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ALAYA_MODE: "shadow",
      ALAYA_DB_PATH: dbPath,
      ALAYA_API_KEY: "unit-api-key-for-shadow-schema-check",
      ALAYA_CAP_DATABASE_MIGRATION: "false",
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
      ALAYA_REVIEW_TIMEZONE: "Asia/Shanghai",
    },
    encoding: "utf8",
  });
  assert.equal(steady.status, 0, steady.stderr + steady.stdout);

  const missing = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--eval",
    "await import('./server/storage.ts')",
  ], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ALAYA_MODE: "shadow",
      ALAYA_DB_PATH: join(tmp, "missing-schema.db"),
      ALAYA_API_KEY: "unit-api-key-for-shadow-schema-check",
      ALAYA_CAP_DATABASE_MIGRATION: "false",
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
      ALAYA_REVIEW_TIMEZONE: "Asia/Shanghai",
    },
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /Database schema is not initialized/);
});
