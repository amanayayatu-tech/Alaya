import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = "scripts/health-signal-36h-validation.mjs";

function makeGoodEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-health-signal-launch-"));
  const keyFile = join(tmp, "minimax-key");
  writeFileSync(keyFile, "sk-test-minimax-value-that-must-not-be-printed\n", { mode: 0o600 });
  return {
    ...process.env,
    ALAYA_SCHEDULER: "false",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: "openai",
    OPENAI_BASE_URL: "https://api.minimax.io/openai",
    OPENAI_MODEL: "MiniMax-M3",
    OPENAI_API_KEY: "",
    OPENAI_API_KEY_FILE: keyFile,
    MINIMAX_API_KEY: "",
    PORT: "5300",
    ALAYA_DB_PATH: join(tmp, "health-signal.db"),
  };
}

function runCheckOnly(env, extraArgs = []) {
  return spawnSync(process.execPath, [runner, "--check-only", ...extraArgs], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function parseStatus(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout should be JSON:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("health-signal launch guard rejects missing OpenAI-compatible key", () => {
  const env = {
    ...makeGoodEnv(),
    OPENAI_API_KEY: "",
    OPENAI_API_KEY_FILE: "",
  };
  const result = runCheckOnly(env);
  const status = parseStatus(result);

  assert.equal(result.status, 2);
  assert.equal(status.ok, false);
  assert.match(status.errors.join("\n"), /OPENAI_API_KEY or a non-empty OPENAI_API_KEY_FILE/);
});

test("health-signal launch guard rejects scheduler pollution", () => {
  const env = {
    ...makeGoodEnv(),
    ALAYA_SCHEDULER: "true",
  };
  const result = runCheckOnly(env);
  const status = parseStatus(result);

  assert.equal(result.status, 2);
  assert.equal(status.ok, false);
  assert.match(status.errors.join("\n"), /ALAYA_SCHEDULER must be explicitly set to false/);
});

test("health-signal launch guard rejects missing DB path", () => {
  const env = {
    ...makeGoodEnv(),
    ALAYA_DB_PATH: "",
  };
  const result = runCheckOnly(env);
  const status = parseStatus(result);

  assert.equal(result.status, 2);
  assert.equal(status.ok, false);
  assert.match(status.errors.join("\n"), /ALAYA_DB_PATH or --db-path must be explicitly set/);
});

test("health-signal launch guard accepts a clean MiniMax validation environment", () => {
  const env = makeGoodEnv();
  const result = runCheckOnly(env);
  const status = parseStatus(result);

  assert.equal(result.status, 0);
  assert.equal(status.ok, true);
  assert.equal(status.config.scheduler, "false");
  assert.equal(status.config.autoSeedDemo, "false");
  assert.equal(status.config.llmProvider, "openai");
  assert.equal(status.config.openaiBaseUrl, "https://api.minimax.io/openai");
  assert.equal(status.config.openaiModel, "MiniMax-M3");
  assert.equal(status.config.openaiApiKeyFileUsable, true);
  assert.doesNotMatch(result.stdout, /sk-test-minimax-value/);
});

test("health-signal monitor contract includes clean 10h retest columns and semantic hold reason", () => {
  const source = readFileSync(join(root, runner), "utf8");

  for (const column of [
    '"round1vsCurrentKnowledgeDelta"',
    '"activeCount"',
    '"newGatesThisHour"',
    '"llmTokenSource"',
  ]) {
    assert.match(source, new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(source, /health\.totals\?\.activeKnowledgeCount/);
  assert.match(source, /payload\.sampleReviewReason/);
  assert.match(source, /llmTokenSourceStats/);
  assert.match(source, /holdEveryMeaningUntilSample/);
  assert.match(source, /heldMeaningGateSampleById/);
  assert.match(source, /scenario === "conflict-flood"/);
  assert.match(source, /scenario === "conflict-flood" && isEquityThesisContradictionGate\(gate\)/);
  assert.match(source, /sourceName === "equity-thesis-contradiction-runner"/);
  assert.match(source, /conflictFloodMaxResolutionsPerSample/);
  assert.match(source, /qualityCanaryBaseline/);
  assert.match(source, /driftFromBaseline/);
  assert.match(source, /oracleEventFields\(template\.side\)/);
  assert.match(source, /scoreResolutionEvent/);
  assert.match(source, /before\.pendingGates\.length > 0[\s\S]+before\.openCycles\.length === 0/);
});

test("health-signal runner keeps duration and final drain from being shortened by sampling holds", () => {
  const source = readFileSync(join(root, runner), "utf8");

  assert.match(source, /durationBoundedMaxSamples = Math\.ceil\(durationMs \/ sampleMs\) \+ 1/);
  assert.match(source, /const maxSamples = Math\.max\(1, Math\.min\(durationBoundedMaxSamples, explicitMaxSamples\)\)/);
  assert.match(source, /Math\.min\(started \+ \(sample - firstSample \+ 1\) \* sampleMs, deadlineAt\)/);
  assert.match(source, /allowSamplingHold = options\.allowSamplingHold !== false/);
  assert.match(source, /resolvePendingGates\(baseUrl, projectId, state, \{ allowSamplingHold: false \}\)/);
});
