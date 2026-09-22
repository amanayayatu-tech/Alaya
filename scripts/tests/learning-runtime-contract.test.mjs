import test from "node:test";
import assert from "node:assert/strict";
import {
  bindLearningPrediction,
  buildLearningCaseProjectPatch,
  buildLearningCaseVisiblePrompt,
  causalCycleFromSchedulerTicks,
  compareHeldoutKnowledgeState,
  heldoutWritePolicy,
  learningQueueDrainStatus,
  LEARNING_DECISION_ENVELOPE_SCHEMA,
  parseRuntimePredictionContract,
} from "../lib/learning-runtime-contract.mjs";

function heldoutCase() {
  return {
    id: "case_hidden_metadata",
    title: "Equity thesis review ALYA-0097",
    pool: "heldout",
    ruleId: "R-secret",
    ruleRef: "seed:R-secret",
    groundTruthDecision: "short_bias",
    expectedDecision: "short_bias",
    calibrationTruth: { mode: "decision_matches_expected" },
    excludeFromDistiller: true,
    excludeFromCreditTraining: true,
    prompt: "This ignored source prompt leaks heldout oracle truth ruleRef.",
    signals: [
      { id: "guidance_cut", label: "guidance cut", text: "Management reduced forward guidance.", polarity: "negative" },
      { id: "liquidity_risk", label: "liquidity risk", text: "Liquidity runway tightened.", polarity: "negative" },
    ],
  };
}

test("model-visible learning prompt contains signals but omits split, rule, truth, oracle, and exclusion metadata", () => {
  const prompt = buildLearningCaseVisiblePrompt(heldoutCase());
  const patch = buildLearningCaseProjectPatch(heldoutCase());
  const modelVisible = `${prompt}\n${JSON.stringify(patch)}`;

  assert.match(modelVisible, /Management reduced forward guidance/);
  assert.match(modelVisible, new RegExp(LEARNING_DECISION_ENVELOPE_SCHEMA.replace(/\./g, "\\.")));
  assert.match(modelVisible, /exactly one compact JSON string/);
  assert.doesNotMatch(modelVisible, /heldout|\btrain\b|ruleRef|R-secret|oracle|ground.?truth|excludeFrom/i);
  assert.doesNotMatch(modelVisible, /case_hidden_metadata/);
});

test("causal binding uses the explicit scheduler cycle and ignores unrelated predictions", () => {
  const cycle = causalCycleFromSchedulerTicks([
    { action: "ran_operational_stages", cycleId: "cycle_old" },
    { action: "created_next_cycle", cycleId: "cycle_old", nextCycleId: "cycle_case" },
    { action: "opened_direction_gate", cycleId: "cycle_case" },
    { action: "ran_operational_stages", cycleId: "cycle_case" },
  ]);
  const binding = bindLearningPrediction({
    caseId: "case_001",
    causalCycleId: cycle.cycleId,
    predictions: [
      { id: "pred_old", cycleId: "cycle_old" },
      { id: "pred_case", cycleId: "cycle_case" },
      { id: "pred_later", cycleId: "cycle_later" },
    ],
  });

  assert.equal(cycle.status, "bound");
  assert.equal(binding.status, "bound");
  assert.equal(binding.prediction.id, "pred_case");
  assert.equal(binding.bindingMethod, "scheduler_opened_direction_gate_cycle");
});

test("causal binding fails closed when the cycle or prediction is absent or ambiguous", () => {
  assert.equal(causalCycleFromSchedulerTicks([]).status, "missing");
  assert.equal(causalCycleFromSchedulerTicks([
    { action: "opened_direction_gate", cycleId: "cycle_a" },
    { action: "opened_direction_gate", cycleId: "cycle_b" },
  ]).status, "ambiguous");

  assert.deepEqual(bindLearningPrediction({
    caseId: "case_001",
    causalCycleId: "cycle_case",
    predictions: [{ id: "pred_other", cycleId: "cycle_other" }],
  }).status, "missing");
  assert.equal(bindLearningPrediction({
    caseId: "case_001",
    causalCycleId: "cycle_case",
    predictions: [
      { id: "pred_a", cycleId: "cycle_case" },
      { id: "pred_b", cycleId: "cycle_case" },
    ],
  }).status, "ambiguous");
});

const ACTION_SENTINEL = "apply_structured_learning_decision";
const ENVELOPE_TOKENS = Object.freeze([
  "{",
  '"schema"',
  ":",
  `"${LEARNING_DECISION_ENVELOPE_SCHEMA}"`,
  ",",
  '"decision"',
  ":",
  '"reduce_exposure"',
  ",",
  '"confidence"',
  ":",
  "0.5",
  "}",
]);

function envelopeWithConfidence(confidenceLexeme) {
  return `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":${confidenceLexeme}}`;
}

function parseRawEnvelope(originalRaw, ...args) {
  const action = args.length > 0 ? args[0] : ACTION_SENTINEL;
  const extra = args[1] ?? {};
  const result = parseRuntimePredictionContract({ prediction: originalRaw, action, ...extra });
  if (result.status === "ok") {
    assert.doesNotThrow(() => JSON.parse(originalRaw), `status=ok requires native JSON.parse success: ${JSON.stringify(originalRaw)}`);
  }
  return result;
}

function payloadAtBoundary(boundary, whitespace) {
  return `${ENVELOPE_TOKENS.slice(0, boundary).join("")}${whitespace}${ENVELOPE_TOKENS.slice(boundary).join("")}`;
}

test("runtime response parser accepts only the exact structured decision envelope", () => {
  const envelope = JSON.stringify({
    schema: LEARNING_DECISION_ENVELOPE_SCHEMA,
    decision: "reduce_exposure",
    confidence: 0.62,
  });
  assert.deepEqual(parseRuntimePredictionContract({ prediction: envelope, action: "apply_structured_learning_decision" }), {
    status: "ok",
    reason: null,
    decision: "reduce_exposure",
    confidence: 0.62,
    sourceField: "prediction",
    sourceFields: ["prediction"],
    labels: ["reduce_exposure"],
  });
  assert.equal(parseRuntimePredictionContract({ action: "reduce_exposure" }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ action: "Do not choose reduce_exposure." }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ prediction: envelope, action: "Take a cautious action." }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ prediction: "The signals look weak, so be cautious.", action: "apply_structured_learning_decision" }).status, "missing");
  assert.equal(parseRuntimePredictionContract({ prediction: '{"schema":"alaya.learning_loop.decision.v1"' }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ prediction: JSON.stringify({
    schema: LEARNING_DECISION_ENVELOPE_SCHEMA,
    decision: "buy_everything",
    confidence: 0.5,
  }) }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ prediction: JSON.stringify({
    schema: LEARNING_DECISION_ENVELOPE_SCHEMA,
    decision: "reduce_exposure",
    confidence: 1.01,
  }) }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ prediction: JSON.stringify({
    schema: LEARNING_DECISION_ENVELOPE_SCHEMA,
    decision: "reduce_exposure",
    confidence: 0.5,
    action: "short_bias",
  }) }).status, "invalid");
});

test("runtime response parser rejects duplicate decoded keys and trailing JSON data", () => {
  const malformed = [
    `{"schema":"wrong","schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"short_bias","decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":9,"confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","dec\\u0069sion":"short_bias","decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5}{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"short_bias","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":NaN}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":Infinity}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5/*comment*/}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5,"decision_alias":"short_bias"}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5,}`,
  ];

  for (const prediction of malformed) {
    const result = parseRuntimePredictionContract({ prediction, action: "apply_structured_learning_decision" });
    assert.equal(result.status, "invalid", prediction);
  }
});

test("runtime response parser rejects every non-JSON Unicode whitespace at every token boundary", () => {
  const invalidWhitespaceCodePoints = [
    0x00a0, 0x000b, 0x000c, 0x2028, 0x2029, 0x0085, 0x1680,
    ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
    0x202f, 0x205f, 0x3000, 0xfeff,
  ];
  const accepted = [];
  for (const codePoint of invalidWhitespaceCodePoints) {
    const whitespace = String.fromCodePoint(codePoint);
    for (let boundary = 0; boundary <= ENVELOPE_TOKENS.length; boundary += 1) {
      const originalRaw = payloadAtBoundary(boundary, whitespace);
      const result = parseRuntimePredictionContract({ prediction: originalRaw, action: ACTION_SENTINEL });
      if (result.status === "ok") accepted.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}@${boundary}`);
      if (result.reason) assert.doesNotMatch(result.reason, /SyntaxError|Unexpected token|JSON at position/i);
    }
  }
  assert.equal(accepted.length, 0, `accepted invalid JSON whitespace (${accepted.length}): ${accepted.slice(0, 24).join(", ")}`);
});

test("runtime response parser accepts only the four JSON whitespace code points at all token boundaries", () => {
  for (const whitespace of [" ", "\t", "\n", "\r"]) {
    for (let boundary = 0; boundary <= ENVELOPE_TOKENS.length; boundary += 1) {
      const result = parseRawEnvelope(payloadAtBoundary(boundary, whitespace));
      assert.equal(result.status, "ok", `${JSON.stringify(whitespace)} at boundary ${boundary}: ${result.reason}`);
    }
  }
});

test("runtime response parser rejects raw controls and invalid string escapes but semantically validates Unicode inside strings", () => {
  for (let codePoint = 0; codePoint <= 0x1f; codePoint += 1) {
    const rawControl = String.fromCodePoint(codePoint);
    const originalRaw = `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_${rawControl}exposure","confidence":0.5}`;
    assert.notEqual(parseRawEnvelope(originalRaw).status, "ok", `raw U+${codePoint.toString(16).padStart(4, "0")}`);
  }

  for (const originalRaw of [
    String.raw`{"schema":"alaya.learning_loop.decision.v1","decision":"reduce\x_exposure","confidence":0.5}`,
    String.raw`{"schema":"alaya.learning_loop.decision.v1","decision":"reduce_\u123","confidence":0.5}`,
    String.raw`{"schema":"alaya.learning_loop.decision.v1","decision":"reduce_exposure\","confidence":0.5}`,
  ]) {
    assert.notEqual(parseRawEnvelope(originalRaw).status, "ok", originalRaw);
  }

  const nbsp = String.fromCodePoint(0x00a0);
  const cjk = String.fromCodePoint(0x51cf, 0x4ed3);
  const emoji = String.fromCodePoint(0x1f600);
  const unicodeCases = [
    [`{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}${nbsp}","decision":"reduce_exposure","confidence":0.5}`, "decision_envelope_schema_mismatch"],
    [`{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"${cjk}","confidence":0.5}`, "decision_envelope_invalid_decision"],
    [`{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure${emoji}","confidence":0.5}`, "decision_envelope_invalid_decision"],
  ];
  for (const [originalRaw, reason] of unicodeCases) {
    const result = parseRawEnvelope(originalRaw);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, reason);
    assert.doesNotThrow(() => JSON.parse(originalRaw));
  }
});

test("runtime response parser rejects duplicate-equivalent, missing, extra, aliased, nested, and non-object structures", () => {
  const malformed = [
    `{"schema":"wrong","sch\\u0065ma":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":9,"confid\\u0065nce":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","dec\\u0069sion":"short_bias","decision":"reduce_exposure","confidence":0.5}`,
    `{"decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure"}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5,"alias":"short_bias"}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5,"__proto__":"x"}`,
    `{"schema":{"value":"${LEARNING_DECISION_ENVELOPE_SCHEMA}"},"decision":"reduce_exposure","confidence":0.5}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":["reduce_exposure"],"confidence":0.5}`,
    "[]", "null", "true", "0", '"prose"',
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5//comment\n}`,
    `{"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"reduce_exposure","confidence":0.5,}`,
    `\`\`\`json\n${envelopeWithConfidence("0.5")}\n\`\`\``,
    `Use ${envelopeWithConfidence("0.5")}`,
    `${envelopeWithConfidence("0.5")} ${envelopeWithConfidence("0.5")}`,
  ];
  for (const originalRaw of malformed) {
    assert.notEqual(parseRawEnvelope(originalRaw).status, "ok", originalRaw);
  }
});

test("runtime response parser enforces JSON number grammar and lexeme-aware mathematical confidence range", () => {
  const rejectedLexemes = [
    "NaN", "Infinity", "-Infinity", "+0.5", ".5", "01", "1.", "1e", "1e+",
    "0x1", "0b1", "1_0", "-0.0001", "1.0001", "1e309", "1e400",
    "-1e-400", "1.0000000000000001",
  ];
  const incorrectlyAccepted = [];
  for (const lexeme of rejectedLexemes) {
    if (parseRawEnvelope(envelopeWithConfidence(lexeme)).status === "ok") incorrectlyAccepted.push(lexeme);
  }
  for (const wrongType of ['"0.5"', "null", "true", "{}", "[]"]) {
    if (parseRawEnvelope(envelopeWithConfidence(wrongType)).status === "ok") incorrectlyAccepted.push(wrongType);
  }
  assert.deepEqual(incorrectlyAccepted, []);

  const accepted = new Map([
    ["0", 0],
    ["-0", -0],
    ["1", 1],
    ["0.5", 0.5],
    ["5e-1", 0.5],
    ["10e-1", 1],
  ]);
  for (const [lexeme, expected] of accepted) {
    const originalRaw = envelopeWithConfidence(lexeme);
    const result = parseRawEnvelope(originalRaw);
    assert.equal(result.status, "ok", `${lexeme}: ${result.reason}`);
    assert.equal(Object.is(result.confidence, expected), true, lexeme);
  }
});

test("runtime response parser requires the exact untrimmed action sentinel", () => {
  const originalRaw = envelopeWithConfidence("0.5");
  assert.equal(parseRawEnvelope(originalRaw, ACTION_SENTINEL).status, "ok");
  const incorrectlyAccepted = [];
  for (const whitespace of [
    " ",
    String.fromCodePoint(0x00a0),
    String.fromCodePoint(0x000b),
    String.fromCodePoint(0x000c),
    String.fromCodePoint(0x2028),
    String.fromCodePoint(0x2029),
  ]) {
    if (parseRawEnvelope(originalRaw, `${whitespace}${ACTION_SENTINEL}`).status === "ok") incorrectlyAccepted.push(`leading U+${whitespace.codePointAt(0).toString(16)}`);
    if (parseRawEnvelope(originalRaw, `${ACTION_SENTINEL}${whitespace}`).status === "ok") incorrectlyAccepted.push(`trailing U+${whitespace.codePointAt(0).toString(16)}`);
  }
  assert.deepEqual(incorrectlyAccepted, []);
  assert.equal(parseRawEnvelope(originalRaw, undefined).status, "invalid");
  assert.equal(parseRawEnvelope(originalRaw, 123).status, "invalid");
  assert.equal(parseRawEnvelope(originalRaw, originalRaw).status, "invalid");
});

test("runtime response parser requires structured payloads across fields to agree", () => {
  const reduce = JSON.stringify({ schema: LEARNING_DECISION_ENVELOPE_SCHEMA, decision: "reduce_exposure", confidence: 0.62 });
  const equivalent = JSON.stringify({ confidence: 0.62, decision: "reduce_exposure", schema: LEARNING_DECISION_ENVELOPE_SCHEMA });
  const short = JSON.stringify({ schema: LEARNING_DECISION_ENVELOPE_SCHEMA, decision: "short_bias", confidence: 0.62 });
  assert.equal(parseRuntimePredictionContract({ action: ACTION_SENTINEL, prediction: reduce, belief: equivalent }).status, "ok");
  assert.equal(parseRuntimePredictionContract({ action: reduce, prediction: short }).status, "invalid");
  assert.equal(parseRuntimePredictionContract({ action: "apply_structured_learning_decision", prediction: reduce, belief: short }).status, "ambiguous");
});

test("heldout policy requires byte-stable knowledge state including retrieval telemetry", () => {
  const policy = heldoutWritePolicy(heldoutCase());
  const before = [{ id: "kb_1", status: "active", evidenceAlpha: 3, evidenceBeta: 2, confidenceScore: 0.6, confidenceLevel: "medium", usageCount: 4, lastInjectedAt: 100 }];
  const unchanged = structuredClone(before);
  const telemetryMutation = [{ ...before[0], usageCount: 5, lastInjectedAt: 200 }];
  const leakedCredit = [{ ...before[0], evidenceAlpha: 4, confidenceScore: 2 / 3 }];

  assert.equal(policy.knowledgeRetrievalMode, "read_only");
  assert.equal(policy.excludeFromDistiller, true);
  assert.equal(policy.excludeFromCreditTraining, true);
  assert.deepEqual(policy.blockedPaths, ["knowledge_retrieval_mutation", "feedback_import", "distiller", "prediction_resolution", "knowledge_credit", "roi_training"]);
  assert.equal(compareHeldoutKnowledgeState(before, unchanged).passed, true);
  assert.equal(compareHeldoutKnowledgeState(before, telemetryMutation).passed, false);
  assert.deepEqual(compareHeldoutKnowledgeState(before, telemetryMutation).telemetryMutationIds, ["kb_1"]);
  assert.deepEqual(compareHeldoutKnowledgeState(before, telemetryMutation).fieldMutationsById.kb_1, ["usageCount", "lastInjectedAt"]);
  assert.equal(compareHeldoutKnowledgeState(before, leakedCredit).passed, false);
  assert.deepEqual(compareHeldoutKnowledgeState(before, leakedCredit).evidenceMutationIds, ["kb_1"]);
});

test("learning queue completion cannot report complete with queued cases or a hard failure", () => {
  assert.deepEqual(learningQueueDrainStatus({ totalCases: 120, emittedCases: 120 }), {
    status: "complete",
    totalCases: 120,
    emittedCases: 120,
    queuedCaseCount: 0,
    hardFailure: null,
  });
  assert.equal(learningQueueDrainStatus({ totalCases: 120, emittedCases: 112 }).status, "incomplete");
  assert.equal(learningQueueDrainStatus({ totalCases: 120, emittedCases: 120, hardFailure: "binding_failed" }).status, "incomplete");
});
