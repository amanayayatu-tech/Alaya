export const LEARNING_DECISIONS = Object.freeze([
  "increase_long",
  "maintain_long",
  "reduce_exposure",
  "avoid_trade",
  "short_bias",
]);
export const LEARNING_DECISION_ENVELOPE_SCHEMA = "alaya.learning_loop.decision.v1";

const ACTIVE_KNOWLEDGE_STATUSES = new Set(["active", "strong"]);

function normalizePool(value) {
  const pool = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return pool === "held_out" || pool === "holdout" ? "heldout" : pool;
}

function signalLines(testCase) {
  if (!Array.isArray(testCase?.signals)) return [];
  return testCase.signals.map((signal) => {
    const label = String(signal?.label ?? signal?.id ?? "signal").trim();
    const text = String(signal?.text ?? signal?.label ?? signal?.id ?? "").trim();
    const polarity = String(signal?.polarity ?? "unknown").trim();
    return `- ${label}: ${text} [${polarity}]`;
  });
}

export function learningCaseId(testCase) {
  return String(testCase?.id ?? testCase?.externalId ?? "").trim();
}

export function learningCaseGroundTruth(testCase) {
  return String(testCase?.groundTruthDecision ?? testCase?.expectedDecision ?? testCase?.oracle?.decision ?? "").trim();
}

export function isHeldoutLearningCase(testCase) {
  return normalizePool(testCase?.pool ?? testCase?.split) === "heldout";
}

export function buildLearningCaseVisiblePrompt(testCase) {
  const signals = signalLines(testCase);
  return [
    testCase?.title ? `Title: ${String(testCase.title).trim()}` : "Equity thesis decision",
    "Task: Choose the thesis direction that best matches the visible signal bundle.",
    signals.length > 0 ? `Signals:\n${signals.join("\n")}` : "Signals: none supplied",
    `Set the plan_cycle prediction field to exactly one compact JSON string with schema: {"schema":"${LEARNING_DECISION_ENVELOPE_SCHEMA}","decision":"<increase_long|maintain_long|reduce_exposure|avoid_trade|short_bias>","confidence":<number from 0 through 1>}.`,
    "The envelope must contain exactly schema, decision, and confidence. Do not add prose, markdown, aliases, extra keys, or a second decision.",
    "Set the action field to apply_structured_learning_decision and do not place a decision label in any other field.",
    "Use only the visible signal bundle in this prompt.",
  ].join("\n");
}

export function buildLearningCaseProjectPatch(testCase) {
  const visiblePrompt = buildLearningCaseVisiblePrompt(testCase);
  return {
    direction: [
      "Choose one canonical equity-thesis decision from the visible signals only.",
      `The prediction field must be exactly one ${LEARNING_DECISION_ENVELOPE_SCHEMA} JSON envelope with keys schema, decision, and confidence.`,
      "The action field must be exactly apply_structured_learning_decision.",
    ].join("\n"),
    targetUser: "learning-loop paired diagnostic evaluator; equity thesis decision scoring",
    redlines: [
      "Use only the visible signals in the current decision prompt.",
      "Ignore warmup-cycle product automation goals such as dry-run, rollback, preview, release, audit, or roadmap actions.",
      "Do not answer with product-roadmap or automation-strategy actions.",
      "Do not emit a bare label or free-text decision; only the exact structured prediction envelope is scoreable.",
    ],
    firstClaimMetric: "decision_confidence",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.6,
    seedIdentity: [
      "The current runtime task overrides prior warmup cycle goals and feedback.",
      "Allowed labels: increase_long, maintain_long, reduce_exposure, avoid_trade, short_bias.",
      visiblePrompt,
    ].join("\n"),
    worldModel: [
      "This project is temporarily scoped to one generated equity-thesis decision.",
      "Ignore previous runtime warmup product or automation context except mandatory governance redlines.",
      visiblePrompt,
    ].join("\n"),
  };
}

const DECISION_ENVELOPE_KEYS = Object.freeze(["confidence", "decision", "schema"]);
const DECISION_RECORD_FIELDS = Object.freeze(["prediction", "belief"]);
const LEARNING_DECISION_ACTION = "apply_structured_learning_decision";

function canonicalLabelsIn(value) {
  const text = String(value ?? "").toLowerCase();
  return LEARNING_DECISIONS.filter((decision) => {
    const escaped = decision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "i").test(text);
  });
}

function skipJsonWhitespace(raw, index) {
  let cursor = index;
  while (cursor < raw.length) {
    const code = raw.charCodeAt(cursor);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    cursor += 1;
  }
  return cursor;
}

function readJsonString(raw, index) {
  if (raw[index] !== '"') throw new Error("decision_envelope_expected_string");
  let cursor = index + 1;
  while (cursor < raw.length) {
    const code = raw.charCodeAt(cursor);
    if (code < 0x20) throw new Error("decision_envelope_invalid_string");
    if (raw[cursor] === '"') {
      const token = raw.slice(index, cursor + 1);
      let value;
      try {
        value = JSON.parse(token);
      } catch {
        throw new Error("decision_envelope_invalid_string");
      }
      if (typeof value !== "string") throw new Error("decision_envelope_expected_string");
      return { value, next: cursor + 1 };
    }
    if (raw[cursor] === "\\") {
      cursor += 1;
      if (cursor >= raw.length || !/["\\/bfnrtu]/.test(raw[cursor])) {
        throw new Error("decision_envelope_invalid_string_escape");
      }
      if (raw[cursor] === "u") {
        const hex = raw.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("decision_envelope_invalid_unicode_escape");
        cursor += 4;
      }
    }
    cursor += 1;
  }
  throw new Error("decision_envelope_unterminated_string");
}

function readJsonNumber(raw, index) {
  const match = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) throw new Error("decision_envelope_expected_number");
  return { lexeme: match[0], next: index + match[0].length };
}

function preScanStrictDecisionEnvelope(raw) {
  try {
    let cursor = skipJsonWhitespace(raw, 0);
    if (raw[cursor] !== "{") throw new Error("decision_envelope_must_be_object");
    cursor += 1;
    const seen = new Set();
    let confidenceLexeme = null;
    let afterComma = false;
    while (true) {
      cursor = skipJsonWhitespace(raw, cursor);
      if (raw[cursor] === "}") {
        if (afterComma) throw new Error("decision_envelope_trailing_comma");
        cursor += 1;
        break;
      }
      const keyToken = readJsonString(raw, cursor);
      const key = keyToken.value;
      if (seen.has(key)) throw new Error(`decision_envelope_duplicate_key:${key}`);
      seen.add(key);
      if (!DECISION_ENVELOPE_KEYS.includes(key)) throw new Error(`decision_envelope_unknown_key:${key}`);
      cursor = skipJsonWhitespace(raw, keyToken.next);
      if (raw[cursor] !== ":") throw new Error("decision_envelope_expected_colon");
      cursor = skipJsonWhitespace(raw, cursor + 1);
      const valueToken = key === "confidence" ? readJsonNumber(raw, cursor) : readJsonString(raw, cursor);
      if (key === "confidence") confidenceLexeme = valueToken.lexeme;
      afterComma = false;
      cursor = skipJsonWhitespace(raw, valueToken.next);
      if (raw[cursor] === ",") {
        afterComma = true;
        cursor += 1;
        continue;
      }
      if (raw[cursor] === "}") {
        cursor += 1;
        break;
      }
      throw new Error("decision_envelope_expected_comma_or_end");
    }
    cursor = skipJsonWhitespace(raw, cursor);
    if (cursor !== raw.length) throw new Error("decision_envelope_trailing_data");
    const keys = Array.from(seen).sort();
    if (keys.length !== DECISION_ENVELOPE_KEYS.length || keys.some((key, index) => key !== DECISION_ENVELOPE_KEYS[index])) {
      throw new Error("decision_envelope_keys_mismatch");
    }
    return { ok: true, confidenceLexeme };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "decision_envelope_invalid_json" };
  }
}

function confidenceLexemeWithinUnitInterval(lexeme) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if (!match) return false;
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`;
  const significant = digits.replace(/^0+/, "");
  if (!significant) return true;
  if (match[1] === "-") return false;

  const exponent = BigInt(match[4] ?? "0");
  const decimalMagnitude = BigInt(significant.length) + exponent - BigInt(fraction.length);
  if (decimalMagnitude < 1n) return true;
  if (decimalMagnitude > 1n) return false;
  return significant[0] === "1" && !/[1-9]/.test(significant.slice(1));
}

function parseDecisionEnvelopeField(field, value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return { status: "absent", field };
  const labels = canonicalLabelsIn(raw);
  const strict = preScanStrictDecisionEnvelope(raw);
  if (!strict.ok) {
    const firstToken = raw[skipJsonWhitespace(raw, 0)];
    if (labels.length > 0 || firstToken === "{" || firstToken === "[") {
      return { status: "invalid", field, reason: strict.reason, labels };
    }
    return { status: "non_candidate", field };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", field, reason: "decision_envelope_invalid_json", labels };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", field, reason: "decision_envelope_must_be_object", labels };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== DECISION_ENVELOPE_KEYS.length || keys.some((key, index) => key !== DECISION_ENVELOPE_KEYS[index])) {
    return { status: "invalid", field, reason: "decision_envelope_keys_mismatch", labels };
  }
  if (parsed.schema !== LEARNING_DECISION_ENVELOPE_SCHEMA) {
    return { status: "invalid", field, reason: "decision_envelope_schema_mismatch", labels };
  }
  if (typeof parsed.decision !== "string" || !LEARNING_DECISIONS.includes(parsed.decision)) {
    return { status: "invalid", field, reason: "decision_envelope_invalid_decision", labels };
  }
  if (
    typeof parsed.confidence !== "number"
    || !Number.isFinite(parsed.confidence)
    || !confidenceLexemeWithinUnitInterval(strict.confidenceLexeme)
    || parsed.confidence < 0
    || parsed.confidence > 1
  ) {
    return { status: "invalid", field, reason: "decision_envelope_invalid_confidence", labels: [parsed.decision] };
  }
  const envelope = {
    schema: parsed.schema,
    decision: parsed.decision,
    confidence: parsed.confidence,
  };
  return {
    status: "valid",
    field,
    envelope,
    canonical: JSON.stringify(envelope),
    labels: [parsed.decision],
  };
}

export function parseRuntimePredictionContract(prediction) {
  if (prediction?.action !== LEARNING_DECISION_ACTION) {
    return {
      status: "invalid",
      reason: "action_contract_mismatch",
      decision: null,
      confidence: null,
      sourceField: "action",
      sourceFields: [],
      labels: [],
    };
  }
  const candidates = DECISION_RECORD_FIELDS.map((field) => parseDecisionEnvelopeField(field, prediction?.[field]));
  const byField = new Map(candidates.map((candidate) => [candidate.field, candidate]));
  const predictionCandidate = byField.get("prediction");
  const invalid = candidates.find((candidate) => candidate.status === "invalid");
  if (invalid) {
    return {
      status: "invalid",
      reason: invalid.reason,
      decision: null,
      confidence: null,
      sourceField: invalid.field,
      sourceFields: [],
      labels: invalid.labels ?? [],
    };
  }
  if (["absent", "non_candidate"].includes(predictionCandidate?.status)) {
    return {
      status: "missing",
      reason: "prediction_decision_envelope_missing",
      decision: null,
      confidence: null,
      sourceField: "prediction",
      sourceFields: [],
      labels: [],
    };
  }
  const valid = candidates.filter((candidate) => candidate.status === "valid");
  if (valid.length === 0) {
    return { status: "missing", reason: "structured_decision_envelope_missing", decision: null, confidence: null, sourceField: null, sourceFields: [], labels: [] };
  }
  const canonical = new Set(valid.map((candidate) => candidate.canonical));
  if (canonical.size !== 1) {
    return {
      status: "ambiguous",
      reason: "conflicting_structured_decision_envelopes",
      decision: null,
      confidence: null,
      sourceField: null,
      sourceFields: valid.map((candidate) => candidate.field),
      labels: Array.from(new Set(valid.flatMap((candidate) => candidate.labels))),
    };
  }
  const envelope = valid[0].envelope;
  const sourceFields = valid.map((candidate) => candidate.field);
  return {
    status: "ok",
    reason: null,
    decision: envelope.decision,
    confidence: envelope.confidence,
    sourceField: sourceFields.join("+"),
    sourceFields,
    labels: [envelope.decision],
  };
}

export function causalCycleFromSchedulerTicks(ticks = []) {
  const cycleIds = Array.from(new Set((ticks ?? [])
    .filter((tick) => tick?.action === "opened_direction_gate")
    .map((tick) => String(tick?.cycleId ?? "").trim())
    .filter(Boolean)));
  if (cycleIds.length === 0) return { status: "missing", cycleId: null, cycleIds };
  if (cycleIds.length > 1) return { status: "ambiguous", cycleId: null, cycleIds };
  return { status: "bound", cycleId: cycleIds[0], cycleIds };
}

export function bindLearningPrediction({ caseId, causalCycleId, predictions = [] } = {}) {
  const normalizedCaseId = String(caseId ?? "").trim();
  const normalizedCycleId = String(causalCycleId ?? "").trim();
  if (!normalizedCaseId || !normalizedCycleId) {
    return {
      status: "missing",
      reason: !normalizedCaseId ? "missing_case_id" : "missing_causal_cycle_id",
      caseId: normalizedCaseId || null,
      cycleId: normalizedCycleId || null,
      prediction: null,
      candidatePredictionIds: [],
    };
  }
  const candidates = (predictions ?? []).filter((prediction) => (
    prediction?.id && String(prediction?.cycleId ?? "") === normalizedCycleId
  ));
  if (candidates.length !== 1) {
    return {
      status: candidates.length === 0 ? "missing" : "ambiguous",
      reason: candidates.length === 0 ? "no_prediction_for_causal_cycle" : "multiple_predictions_for_causal_cycle",
      caseId: normalizedCaseId,
      cycleId: normalizedCycleId,
      prediction: null,
      candidatePredictionIds: candidates.map((prediction) => prediction.id),
    };
  }
  return {
    status: "bound",
    reason: null,
    bindingMethod: "scheduler_opened_direction_gate_cycle",
    caseId: normalizedCaseId,
    cycleId: normalizedCycleId,
    prediction: candidates[0],
    candidatePredictionIds: [candidates[0].id],
  };
}

export function heldoutWritePolicy(testCase) {
  const heldout = isHeldoutLearningCase(testCase);
  return {
    heldout,
    knowledgeRetrievalMode: heldout ? "read_only" : "mutating",
    excludeFromDistiller: heldout,
    excludeFromCreditTraining: heldout,
    blockedPaths: heldout
      ? ["knowledge_retrieval_mutation", "feedback_import", "distiller", "prediction_resolution", "knowledge_credit", "roi_training"]
      : [],
  };
}

const KNOWLEDGE_STATE_FIELDS = Object.freeze([
  "projectId", "type", "title", "content", "sourceType", "sourceRef",
  "evidenceAlpha", "evidenceBeta", "confidenceScore", "confidenceLevel", "status",
  "humanApprovedCount", "externalVerifiedCount", "validFrom", "validUntil",
  "lastValidatedCycle", "createdByCycle", "createdBy", "approvedBy", "usageCount",
  "lastInjectedAt", "lastVerifiedAt", "lastDecayedAt", "grayStreak", "storageStrength",
  "noveltyScore", "sourceRound", "tags", "notes", "supersededBy", "semanticKey", "version",
]);

function knowledgeField(item, field) {
  if (Object.prototype.hasOwnProperty.call(item ?? {}, field)) return item[field];
  const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return item?.[snake] ?? null;
}

function knowledgeState(item) {
  const id = String(item?.id ?? "");
  return {
    id,
    values: Object.fromEntries(KNOWLEDGE_STATE_FIELDS.map((field) => [field, knowledgeField(item, field)])),
  };
}

export function compareHeldoutKnowledgeState(beforeItems = [], afterItems = []) {
  const before = new Map(beforeItems.map(knowledgeState).filter((item) => item.id).map((item) => [item.id, item]));
  const after = new Map(afterItems.map(knowledgeState).filter((item) => item.id).map((item) => [item.id, item]));
  const newActiveKnowledgeIds = [];
  const newKnowledgeIds = [];
  const evidenceMutationIds = [];
  const lifecycleMutationIds = [];
  const telemetryMutationIds = [];
  const mutatedKnowledgeIds = [];
  const fieldMutationsById = {};
  const removedKnowledgeIds = [];

  for (const [id, item] of after.entries()) {
    const prior = before.get(id);
    if (!prior) {
      newKnowledgeIds.push(id);
      if (ACTIVE_KNOWLEDGE_STATUSES.has(item.values.status)) newActiveKnowledgeIds.push(id);
      continue;
    }
    const changedFields = KNOWLEDGE_STATE_FIELDS.filter((field) => !Object.is(item.values[field], prior.values[field]));
    if (changedFields.length === 0) continue;
    mutatedKnowledgeIds.push(id);
    fieldMutationsById[id] = changedFields;
    if (changedFields.some((field) => field === "evidenceAlpha" || field === "evidenceBeta" || field === "confidenceScore" || field === "confidenceLevel")) evidenceMutationIds.push(id);
    if (changedFields.some((field) => field === "status" || field === "supersededBy" || field === "validFrom" || field === "validUntil")) lifecycleMutationIds.push(id);
    if (changedFields.some((field) => field === "usageCount" || field === "lastInjectedAt")) telemetryMutationIds.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removedKnowledgeIds.push(id);
  }

  return {
    passed: newKnowledgeIds.length === 0 && mutatedKnowledgeIds.length === 0 && removedKnowledgeIds.length === 0,
    newKnowledgeIds,
    newActiveKnowledgeIds,
    mutatedKnowledgeIds,
    fieldMutationsById,
    evidenceMutationIds,
    lifecycleMutationIds,
    removedKnowledgeIds,
    telemetryMutationIds,
  };
}

export function learningQueueDrainStatus({ totalCases, emittedCases, hardFailure = null } = {}) {
  const total = Math.max(0, Math.trunc(Number(totalCases) || 0));
  const emitted = Math.max(0, Math.min(total, Math.trunc(Number(emittedCases) || 0)));
  const queuedCaseCount = total - emitted;
  return {
    status: queuedCaseCount === 0 && !hardFailure ? "complete" : "incomplete",
    totalCases: total,
    emittedCases: emitted,
    queuedCaseCount,
    hardFailure: hardFailure ? String(hardFailure) : null,
  };
}
