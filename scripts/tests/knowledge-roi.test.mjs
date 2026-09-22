import test from "node:test";
import assert from "node:assert/strict";
import { estimateMarginalValue } from "../lib/knowledge-roi.mjs";

function trace(cycleId, injectedKnowledgeIds, candidateIds = ["kb_a"]) {
  return {
    cycleId,
    kind: "knowledge_injection",
    attributes: {
      candidateIds,
      injectedKnowledgeIds,
      droppedKnowledgeId: injectedKnowledgeIds.includes("kb_a") ? null : "kb_a",
    },
  };
}

test("synthetic trace and outcomes produce hand-computed marginal value delta", () => {
  const traceEvents = [];
  const outcomes = [];
  for (let i = 0; i < 20; i += 1) {
    const cycleId = `cycle_${i}`;
    const withKnowledge = i < 10;
    const correct = withKnowledge ? i < 8 : i < 15;
    traceEvents.push(trace(cycleId, withKnowledge ? ["kb_a"] : []));
    outcomes.push({ cycleId, correct });
  }

  const result = estimateMarginalValue(traceEvents, outcomes);
  assert.deepEqual(result.get("kb_a"), {
    status: "OK",
    withN: 10,
    withoutN: 10,
    withAcc: 0.8,
    withoutAcc: 0.5,
    delta: 0.3,
  });
});

test("LOW_COVERAGE is returned without a delta point estimate", () => {
  const traceEvents = [];
  const outcomes = [];
  for (let i = 0; i < 10; i += 1) {
    const cycleId = `low_${i}`;
    const withKnowledge = i < 4;
    traceEvents.push(trace(cycleId, withKnowledge ? ["kb_low"] : [], ["kb_low"]));
    outcomes.push({ cycleId, correct: i % 2 === 0 });
  }

  const result = estimateMarginalValue(traceEvents, outcomes).get("kb_low");
  assert.equal(result.status, "LOW_COVERAGE");
  assert.equal(result.withN, 4);
  assert.equal(result.withoutN, 6);
  assert.equal(Object.hasOwn(result, "delta"), false);
});
