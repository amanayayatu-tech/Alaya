function parseAttributes(event) {
  const raw = event?.attributes ?? event?.attrs ?? event;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function cycleIdForEvent(event, attrs) {
  return String(event?.cycleId ?? event?.cycle_id ?? attrs?.cycleId ?? "").trim();
}

function outcomeCorrect(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value > 0;
  if (!value || typeof value !== "object") return null;
  for (const key of ["correct", "decisionCorrect", "decision_correct", "success", "passed"]) {
    if (typeof value[key] === "boolean") return value[key];
  }
  for (const key of ["accuracy", "score"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key] > 0;
  }
  const outcome = String(value.outcome ?? value.result ?? "").toLowerCase();
  if (["correct", "success", "pass", "passed", "true"].includes(outcome)) return true;
  if (["wrong", "failure", "fail", "failed", "false"].includes(outcome)) return false;
  if (typeof value.predictionError === "number" && Number.isFinite(value.predictionError)) return value.predictionError <= 0;
  if (typeof value.worstClaimError === "number" && Number.isFinite(value.worstClaimError)) return value.worstClaimError <= 0;
  return null;
}

function outcomeCycleId(value, fallbackKey) {
  if (value && typeof value === "object") {
    return String(value.cycleId ?? value.cycle_id ?? value.id ?? fallbackKey ?? "").trim();
  }
  return String(fallbackKey ?? "").trim();
}

function normalizeOutcomes(outcomes) {
  const out = new Map();
  if (outcomes instanceof Map) {
    for (const [key, value] of outcomes.entries()) {
      const cycleId = outcomeCycleId(value, key);
      const correct = outcomeCorrect(value);
      if (cycleId && correct != null) out.set(cycleId, correct);
    }
    return out;
  }
  if (Array.isArray(outcomes)) {
    for (const value of outcomes) {
      const cycleId = outcomeCycleId(value);
      const correct = outcomeCorrect(value);
      if (cycleId && correct != null) out.set(cycleId, correct);
    }
    return out;
  }
  if (outcomes && typeof outcomes === "object") {
    for (const [key, value] of Object.entries(outcomes)) {
      const cycleId = outcomeCycleId(value, key);
      const correct = outcomeCorrect(value);
      if (cycleId && correct != null) out.set(cycleId, correct);
    }
  }
  return out;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateMarginalValue(traceEvents, outcomes) {
  const outcomeByCycle = normalizeOutcomes(outcomes);
  const buckets = new Map();

  for (const event of traceEvents ?? []) {
    const attrs = parseAttributes(event);
    const cycleId = cycleIdForEvent(event, attrs);
    if (!cycleId || !outcomeByCycle.has(cycleId)) continue;
    const correct = outcomeByCycle.get(cycleId);
    const injectedIds = new Set(uniqueStrings(attrs.injectedKnowledgeIds));
    const candidateIds = uniqueStrings(
      Array.isArray(attrs.candidateIds) && attrs.candidateIds.length > 0
        ? attrs.candidateIds
        : [...injectedIds, attrs.droppedKnowledgeId],
    );

    for (const knowledgeId of candidateIds) {
      if (!buckets.has(knowledgeId)) {
        buckets.set(knowledgeId, { withN: 0, withoutN: 0, withCorrect: 0, withoutCorrect: 0 });
      }
      const bucket = buckets.get(knowledgeId);
      if (injectedIds.has(knowledgeId)) {
        bucket.withN += 1;
        if (correct) bucket.withCorrect += 1;
      } else {
        bucket.withoutN += 1;
        if (correct) bucket.withoutCorrect += 1;
      }
    }
  }

  const result = new Map();
  for (const [knowledgeId, bucket] of buckets.entries()) {
    const withAcc = bucket.withN > 0 ? round6(bucket.withCorrect / bucket.withN) : null;
    const withoutAcc = bucket.withoutN > 0 ? round6(bucket.withoutCorrect / bucket.withoutN) : null;
    if (bucket.withN < 5 || bucket.withoutN < 5) {
      result.set(knowledgeId, {
        status: "LOW_COVERAGE",
        withN: bucket.withN,
        withoutN: bucket.withoutN,
        withAcc,
        withoutAcc,
      });
      continue;
    }
    result.set(knowledgeId, {
      status: "OK",
      withN: bucket.withN,
      withoutN: bucket.withoutN,
      withAcc,
      withoutAcc,
      delta: round6(withAcc - withoutAcc),
    });
  }
  return result;
}
