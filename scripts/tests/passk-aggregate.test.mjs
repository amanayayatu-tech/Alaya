import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregatePassK } from "../passk-aggregate.mjs";

function writeQuality(logDir, status) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "quality_summary.json"), `${JSON.stringify({
    decisionTsr: {
      status,
      passed: status === "pass",
    },
  }, null, 2)}\n`);
}

test("passk aggregate computes passAt1 and passPowK for completed seeds", () => {
  const root = mkdtempSync(join(tmpdir(), "passk-complete-"));
  writeQuality(join(root, "seed_0"), "pass");
  writeQuality(join(root, "seed_1"), "pass");
  writeQuality(join(root, "seed_2"), "fail");

  const result = aggregatePassK({ logDir: root, k: 3 });

  assert.equal(result.status, "fail");
  assert.equal(result.k, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.passed, 2);
  assert.equal(result.passAt1, 0.666667);
  assert.equal(result.passPowK, 0);
  assert.deepEqual(result.perSeed.map((run) => run.passed), [true, true, false]);
});

test("passk aggregate marks missing seed summaries incomplete", () => {
  const root = mkdtempSync(join(tmpdir(), "passk-incomplete-"));
  writeFileSync(join(root, "passk_manifest.json"), `${JSON.stringify({
    runs: [
      { seed: 10, logDir: "seed_0" },
      { seed: 11, logDir: "seed_1" },
    ],
  })}\n`);
  writeQuality(join(root, "seed_0"), "pass");

  const result = aggregatePassK({ logDir: root });

  assert.equal(result.status, "incomplete");
  assert.equal(result.k, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.passAt1, 0.5);
  assert.equal(result.passPowK, 0);
  assert.equal(result.perSeed[1].missingReason, "missing_quality_summary");
});
