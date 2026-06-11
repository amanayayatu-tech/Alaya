import { test } from "node:test";
import assert from "node:assert/strict";
import { runRegressionOnGoldCases, type GoldRegressionCase } from "../src/core/regression_validator.js";
import type { AttributionContext } from "../src/core/types.js";

const base: AttributionContext = {
  perceptionFailure: false,
  executionFailure: false,
  humanFlaggedValueMismatch: false,
  isQualitative: false,
};

function goldCase(id: string, patch: Partial<GoldRegressionCase>): GoldRegressionCase {
  return {
    id,
    input: { claimError: 0.8, context: base },
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    ...patch,
  };
}

test("runRegressionOnGoldCases passes active matching cases", () => {
  const result = runRegressionOnGoldCases([
    goldCase("gold_model", {}),
    goldCase("gold_perception", {
      input: { claimError: 0.8, context: { ...base, perceptionFailure: true } },
      expectedErrorType: "perception",
      expectedRoute: "update_data_source",
    }),
  ]);

  assert.deepEqual(result, { passed: true, testedCases: 2, failedCaseIds: [] });
});

test("runRegressionOnGoldCases reports failed case ids for mixed gold sets", () => {
  const result = runRegressionOnGoldCases([
    goldCase("gold_ok", {}),
    goldCase("gold_bad_route", {
      expectedErrorType: "model",
      expectedRoute: "human_meaning_or_direction_gate",
    }),
    goldCase("gold_inactive", {
      active: false,
      expectedErrorType: "value",
      expectedRoute: "human_meaning_or_direction_gate",
    }),
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.testedCases, 2);
  assert.deepEqual(result.failedCaseIds, ["gold_bad_route"]);
});

test("runRegressionOnGoldCases applies ctxOverrides deterministically", () => {
  const cases = [
    goldCase("gold_override", {
      expectedErrorType: "execution",
      expectedRoute: "builder_fix_queue",
    }),
  ];
  const overrides = { executionFailure: true };
  const first = runRegressionOnGoldCases(cases, overrides);
  const second = runRegressionOnGoldCases(cases, overrides);

  assert.deepEqual(first, { passed: true, testedCases: 1, failedCaseIds: [] });
  assert.deepEqual(second, first);
});

test("runRegressionOnGoldCases returns a deterministic empty pass for no active cases", () => {
  const result = runRegressionOnGoldCases([
    goldCase("gold_inactive", { active: false }),
  ]);

  assert.deepEqual(result, { passed: true, testedCases: 0, failedCaseIds: [] });
});
