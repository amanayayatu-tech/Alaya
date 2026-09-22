import test from "node:test";
import assert from "node:assert/strict";
import { createLearningCaseHardStop } from "../lib/learning-case-hard-stop.mjs";
import { learningQueueDrainStatus } from "../lib/learning-runtime-contract.mjs";

test("first learning-case failure latches once and blocks retries while cleanup remains available", async () => {
  const latchEvents = [];
  const stop = createLearningCaseHardStop({ onLatch: (failure) => latchEvents.push(failure) });
  let providerCalls = 0;

  await assert.rejects(
    stop.runProvider({ sample: 7, ordinal: 13, caseId: "case_0013", phase: "sample" }, async () => {
      providerCalls += 1;
      throw new Error("trace identity missing");
    }),
    /trace identity missing/,
  );

  assert.equal(stop.isLatched(), true);
  assert.equal(providerCalls, 1);
  assert.equal(latchEvents.length, 1);
  assert.equal(stop.snapshot().caseId, "case_0013");
  assert.equal(stop.snapshot().reason, "trace identity missing");
  assert.equal(Object.isFrozen(stop.snapshot()), true);

  const retry = await stop.runProvider({ sample: 8, ordinal: 13, caseId: "case_0013", phase: "sample_retry" }, async () => {
    providerCalls += 1;
    return "must-not-run";
  });
  const finalDrainRetry = await stop.runProvider({ sample: 999, ordinal: 13, caseId: "case_0013", phase: "final_drain" }, async () => {
    providerCalls += 1;
    return "must-not-run";
  });

  assert.equal(providerCalls, 1);
  assert.equal(retry.status, "blocked");
  assert.equal(finalDrainRetry.status, "blocked");
  assert.strictEqual(retry.failure, stop.snapshot());
  assert.strictEqual(finalDrainRetry.failure, stop.snapshot());

  const secondLatch = stop.latch({ sample: 8, ordinal: 13, caseId: "case_0013", phase: "sample_retry", reason: "different" });
  assert.equal(secondLatch.latched, false);
  assert.equal(latchEvents.length, 1);
  assert.equal(stop.snapshot().reason, "trace identity missing");

  const cleanupPaths = [];
  await stop.runCleanup(async () => cleanupPaths.push("failure_artifacts"));
  await stop.runCleanup(async () => cleanupPaths.push("baseline_analyzer"));
  await stop.runCleanup(async () => cleanupPaths.push("treatment_analyzer"));
  assert.deepEqual(cleanupPaths, ["failure_artifacts", "baseline_analyzer", "treatment_analyzer"]);

  const queue = learningQueueDrainStatus({
    totalCases: 120,
    emittedCases: 12,
    hardFailure: `learning_case_hard_stop:${stop.snapshot().reason}`,
  });
  assert.equal(queue.status, "incomplete");
  assert.equal(queue.queuedCaseCount, 108);
  assert.match(queue.hardFailure, /learning_case_hard_stop/);
});
