import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { validateEnv, isSchemaMigrationAllowed } = await import("../server/config/env.ts");

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

test("production rejects obvious placeholder secrets", () => {
  const result = validateEnv({
    NODE_ENV: "production",
    ALAYA_MODE: "production",
    ALAYA_DB_PATH: "/var/lib/alaya/alaya.db",
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
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "mock",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(result.errors, []);
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
      ALAYA_CAP_DATABASE_MIGRATION: "false",
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
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
      ALAYA_CAP_DATABASE_MIGRATION: "false",
      ALAYA_AUTO_SEED_DEMO: "false",
      ALAYA_LLM_PROVIDER: "mock",
    },
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /Database schema is not initialized/);
});
