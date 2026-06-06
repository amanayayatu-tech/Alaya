import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-scheduler-concurrency-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { schedulerTickProject } = await import("../server/scheduler.ts");

storage.createProject({
  id: "proj_concurrency",
  name: "Concurrency",
  direction: "Validate scheduler mutex",
  targetUser: "operator",
  redlines: "[]",
  weeklyHumanMinutes: 150,
  weeklyLlmBudgetCents: 100,
  firstClaimMetric: "activation_rate",
  firstClaimOperator: ">=",
  firstClaimTarget: 0.3,
  seedIdentity: "",
  worldModel: "",
  currentCycleIdx: 1,
  version: 1,
});
storage.createCycle({
  id: "cycle_concurrency",
  projectId: "proj_concurrency",
  idx: 1,
  goal: "validate scheduler lock",
  status: "planning",
  eCycle: null,
  worstClaimError: null,
  reasoning: "",
  version: 1,
});

test("scheduler skips overlapping project ticks and resumes after completion", async () => {
  const first = schedulerTickProject("proj_concurrency");
  const second = await schedulerTickProject("proj_concurrency");
  assert.equal(second.action, "skipped");
  assert.equal(second.note, "tick_in_progress");

  const firstResult = await first;
  assert.notEqual(firstResult.action, "skipped");

  const events = storage.listEvents().filter((event) => event.op === "scheduler_tick_skipped");
  assert.ok(events.length >= 1);
  const traces = storage.listTraceEventsByProject("proj_concurrency").filter((event) => event.name === "scheduler_tick_skipped");
  assert.ok(traces.length >= 1);

  const third = await schedulerTickProject("proj_concurrency");
  assert.notEqual(third.action, "skipped");
});
