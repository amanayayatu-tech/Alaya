export const EXPECTED_HEALTH_SIGNAL_DECISION = "hybrid_layered";

export const HEALTH_SIGNAL_ORACLE_BY_SIDE = Object.freeze({
  ppg_support: {
    oracleSide: "ppg_support",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "superseded_or_quarantined_when_conflicted",
    scoreableResolutionRule: "ppg_risk_beats_ppg_support",
  },
  ecg_support: {
    oracleSide: "ecg_support",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "superseded_or_quarantined_when_conflicted",
    scoreableResolutionRule: "ecg_risk_beats_ecg_support",
  },
  ppg_risk: {
    oracleSide: "ppg_risk",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "retained_over_ppg_support",
    scoreableResolutionRule: "ppg_risk_beats_ppg_support",
  },
  ecg_risk: {
    oracleSide: "ecg_risk",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "retained_over_ecg_support",
    scoreableResolutionRule: "ecg_risk_beats_ecg_support",
  },
  hybrid_support: {
    oracleSide: "hybrid_support",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "retained_as_final_decision",
    scoreableResolutionRule: "hybrid_support_beats_hybrid_reject",
  },
  hybrid_reject: {
    oracleSide: "hybrid_reject",
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: "quarantined_or_deprecated",
    scoreableResolutionRule: "hybrid_support_beats_hybrid_reject",
  },
});

const ORACLE_SIDE_PATTERN = /(hybrid_support|hybrid_reject|ppg_support|ppg_risk|ecg_support|ecg_risk)/i;
const ACTIVE_STATUSES = new Set(["active", "strong"]);
const DISALLOWED_FINAL_DECISIONS = new Set(["ppg_only", "ecg_only", "hybrid_reject"]);
export const RESOLUTION_SCOREABLE_COVERAGE_THRESHOLD = 0.6;

export function oracleMetadataForSide(side) {
  const normalized = String(side ?? "").toLowerCase();
  return HEALTH_SIGNAL_ORACLE_BY_SIDE[normalized] ?? null;
}

export function oracleEventFields(side) {
  return oracleMetadataForSide(side) ?? {
    oracleSide: null,
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: null,
    scoreableResolutionRule: null,
  };
}

export function inferOracleSideFromValue(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    for (const key of [
      "oracleSide",
      "side",
      "primaryOracleSide",
      "relatedOracleSide",
      "sourceRef",
      "source_ref",
      "id",
      "primaryKnowledgeId",
      "relatedKnowledgeId",
      "title",
      "content",
      "notes",
    ]) {
      const inferred = inferOracleSideFromValue(value[key]);
      if (inferred) return inferred;
    }
    return null;
  }
  const match = ORACLE_SIDE_PATTERN.exec(String(value));
  return match ? match[1].toLowerCase() : null;
}

function field(item, ...names) {
  for (const name of names) {
    if (item?.[name] != null) return item[name];
  }
  return undefined;
}

function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function textForKnowledge(item) {
  return normalizeSpace([
    field(item, "id"),
    field(item, "title"),
    field(item, "content"),
    field(item, "notes"),
    field(item, "sourceRef", "source_ref"),
    field(item, "semanticKey", "semantic_key"),
    field(item, "tags"),
  ].filter(Boolean).join("\n"));
}

function statusForKnowledge(item) {
  return String(field(item, "status") ?? "").toLowerCase();
}

function supersededByForKnowledge(item) {
  return String(field(item, "supersededBy", "superseded_by") ?? "").trim();
}

function knowledgeId(item) {
  return String(field(item, "id") ?? "");
}

export function classifyHealthSignalDecision(item) {
  const side = inferOracleSideFromValue(item);
  if (side === "ppg_support") return "ppg_only";
  if (side === "ecg_support") return "ecg_only";
  if (side === "hybrid_support" || side === "ppg_risk" || side === "ecg_risk") return "hybrid_layered";
  if (side === "hybrid_reject") return "hybrid_reject";

  const text = textForKnowledge(item);
  if (!text) return "unknown";
  if (/反对混合方案|hybrid_reject|hybrid_decision_confidence\s*<=|双传感器[^。；;]{0,40}(过高|复杂)|保留\s*ECG\s*作为\s*Pro SKU/i.test(text)) {
    return "hybrid_reject";
  }
  if (/PPG\s*\+\s*ECG|PPG[^。；;]{0,80}ECG[^。；;]{0,80}(复核|二次确认|分层|补强|医疗级)|ECG[^。；;]{0,80}PPG[^。；;]{0,80}(连续|趋势|低功耗)|混合方案|分层方案|双模/i.test(text)) {
    return "hybrid_layered";
  }
  if (/(当前最优选型决策[:：]\s*)?优先\s*ECG|ECG\s*优先|ppg_priority_score\s*<=/i.test(text)) {
    return "ecg_only";
  }
  if (/(当前最优选型决策[:：]\s*)?优先\s*PPG|PPG\s*优先|ppg_priority_score\s*>=/i.test(text)) {
    return "ppg_only";
  }
  return "unknown";
}

export function evaluateDecisionTsr(knowledgeItems = []) {
  const eligible = knowledgeItems.filter((item) => (
    ACTIVE_STATUSES.has(statusForKnowledge(item)) && !supersededByForKnowledge(item)
  ));
  const classified = eligible.map((item) => ({
    knowledgeId: knowledgeId(item),
    title: String(field(item, "title") ?? ""),
    oracleSide: inferOracleSideFromValue(item),
    decision: classifyHealthSignalDecision(item),
    status: statusForKnowledge(item),
  }));
  const decisions = new Set(classified.map((item) => item.decision));
  const disallowed = classified.filter((item) => DISALLOWED_FINAL_DECISIONS.has(item.decision));
  const hybrid = classified.filter((item) => item.decision === EXPECTED_HEALTH_SIGNAL_DECISION);
  const passed = hybrid.length > 0 && disallowed.length === 0;
  return {
    status: eligible.length === 0 ? "insufficient_evidence" : (passed ? "pass" : "fail"),
    passed,
    interpretation: "single-scenario pass@1 check: verifies that the final active/strong card state matches the preset Health Signal oracle; it is not an independent reasoning benchmark",
    passK: {
      implemented: false,
      plannedVersion: "v2",
    },
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    eligibleKnowledgeCount: eligible.length,
    hybridLayeredCount: hybrid.length,
    disallowedFinalCount: disallowed.length,
    decisions: Object.fromEntries(Array.from(decisions).sort().map((decision) => [
      decision,
      classified.filter((item) => item.decision === decision).length,
    ])),
    disallowedFinalKnowledge: disallowed,
    hybridLayeredKnowledge: hybrid.slice(0, 20),
  };
}

function expectedWinnerSide(leftSide, rightSide) {
  const pair = new Set([leftSide, rightSide]);
  if (pair.has("hybrid_support") && pair.has("hybrid_reject")) {
    return { winner: "hybrid_support", rule: "hybrid_support_beats_hybrid_reject" };
  }
  if (pair.has("ppg_risk") && pair.has("ppg_support")) {
    return { winner: "ppg_risk", rule: "ppg_risk_beats_ppg_support" };
  }
  if (pair.has("ecg_risk") && pair.has("ecg_support")) {
    return { winner: "ecg_risk", rule: "ecg_risk_beats_ecg_support" };
  }
  return null;
}

function actualWinnerSide(event, primarySide, relatedSide) {
  const action = String(event.action ?? "");
  const survivorSide = inferOracleSideFromValue(event.survivorKnowledgeId);
  if (action === "approve_as_current" || action === "reject_conflict") return primarySide;
  if (action === "quarantine" || action === "downgrade_to_stale") return relatedSide;
  if (action === "merge_supersede") return survivorSide ?? relatedSide;
  return null;
}

export function scoreResolutionEvent(event) {
  const primarySide = inferOracleSideFromValue(event.primaryOracleSide ?? event.primarySide ?? event.primaryKnowledgeId);
  const relatedSide = inferOracleSideFromValue(event.relatedOracleSide ?? event.relatedSide ?? event.relatedKnowledgeId);
  const expected = expectedWinnerSide(primarySide, relatedSide);
  const actual = actualWinnerSide(event, primarySide, relatedSide);
  const scoreable = Boolean(expected && actual);
  return {
    reviewId: event.reviewId ?? null,
    primaryKnowledgeId: event.primaryKnowledgeId ?? null,
    relatedKnowledgeId: event.relatedKnowledgeId ?? null,
    action: event.action ?? null,
    oracleSide: primarySide,
    relatedOracleSide: relatedSide,
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: primarySide ? oracleMetadataForSide(primarySide)?.expectedDisposition ?? null : null,
    scoreableResolutionRule: expected?.rule ?? null,
    resolutionScoreable: scoreable,
    resolutionExpectedWinnerSide: expected?.winner ?? null,
    resolutionActualWinnerSide: actual,
    resolutionCorrect: scoreable ? expected.winner === actual : null,
  };
}

export function scoreResolutionAccuracy(events = []) {
  const resolutionEvents = events.filter((event) => event?.eventType === "knowledge_review_resolved");
  const scored = [];
  const unscored = [];
  for (const event of resolutionEvents) {
    const result = scoreResolutionEvent(event);
    if (result.resolutionScoreable) scored.push(result);
    else unscored.push(result);
  }
  const correct = scored.filter((item) => item.resolutionCorrect).length;
  const totalReviewed = scored.length + unscored.length;
  const scoreableCoverage = totalReviewed === 0 ? null : +(scored.length / totalReviewed).toFixed(6);
  const accuracy = scored.length === 0 ? null : +(correct / scored.length).toFixed(6);
  const lowCoverage = scoreableCoverage != null && scoreableCoverage < RESOLUTION_SCOREABLE_COVERAGE_THRESHOLD;
  let status = "insufficient_evidence";
  if (scored.length > 0 && lowCoverage) status = "low_coverage";
  else if (scored.length > 0) status = accuracy >= 0.9 ? "pass" : "fail";
  return {
    status,
    passed: status === "pass",
    threshold: 0.9,
    accuracy,
    correct,
    scored: scored.length,
    unscored: unscored.length,
    totalReviewed,
    scoreableCoverage,
    scoreableCoverageThreshold: RESOLUTION_SCOREABLE_COVERAGE_THRESHOLD,
    blockingEligible: scored.length > 0 && !lowCoverage,
    scoredEvents: scored,
    unscoredExamples: unscored.slice(0, 20),
  };
}

export function percentile(values, p) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

function safeDivide(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 ? +(n / d).toFixed(6) : null;
}

export function linearSlopePerHour(points = []) {
  const usable = points
    .map((point) => ({
      x: Number(point.hour),
      y: Number(point.value),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (usable.length < 2) return null;
  const xMean = usable.reduce((sum, point) => sum + point.x, 0) / usable.length;
  const yMean = usable.reduce((sum, point) => sum + point.y, 0) / usable.length;
  const denominator = usable.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  if (denominator === 0) return null;
  const numerator = usable.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0);
  return +(numerator / denominator).toFixed(6);
}

function sampleTimeMs(sample, fallbackIndex) {
  const epoch = Number(sample.epoch);
  if (Number.isFinite(epoch) && epoch > 0) return epoch * 1000;
  const iso = Date.parse(sample.iso ?? "");
  if (Number.isFinite(iso)) return iso;
  return fallbackIndex * 60_000;
}

export function rssSlopeMbPerHour(samples = []) {
  const rssRows = samples
    .map((sample, index) => ({
      ts: sampleTimeMs(sample, index),
      rss: Number(sample.appRssMb),
    }))
    .filter((row) => Number.isFinite(row.ts) && Number.isFinite(row.rss));
  if (rssRows.length < 2) return null;
  const firstTs = rssRows[0].ts;
  return linearSlopePerHour(rssRows.map((row) => ({
    hour: (row.ts - firstTs) / 3_600_000,
    value: row.rss,
  })));
}

function latencyStats(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return {
    sampleSize: clean.length,
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
    p99Ms: percentile(clean, 99),
  };
}

export function latencyAndEfficiencyMetrics({ events = [], samples = [], llmCalls = [] } = {}) {
  const apiTimings = events
    .filter((event) => event.eventType === "api_request_timing")
    .map((event) => Number(event.durationMs));
  const apiTimingsBySegment = {};
  for (const event of events.filter((item) => item.eventType === "api_request_timing")) {
    const segment = String(event.segment ?? "harness_polling_api_request");
    apiTimingsBySegment[segment] ??= [];
    apiTimingsBySegment[segment].push(Number(event.durationMs));
  }
  const llmLatencies = llmCalls.map((call) => Number(field(call, "latencyMs", "latency_ms")));
  const byAgent = {};
  for (const call of llmCalls) {
    const agent = String(field(call, "agent") ?? "unknown");
    byAgent[agent] ??= [];
    byAgent[agent].push(Number(field(call, "latencyMs", "latency_ms")));
  }
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  const closedCycles = Number(last.cyclesClosed) || 0;
  const resolvedConflicts = Number(last.resolvedConflictReviews) || 0;
  const netActiveKnowledge = Math.max(0, (Number(last.activeCount) || 0) - (Number(first.activeCount) || 0));
  const totalTokens = llmCalls.reduce((sum, call) => sum + (Number(field(call, "tokenCount", "token_count")) || 0), 0);
  const dbCost = llmCalls.reduce((sum, call) => sum + (Number(field(call, "estimatedCost", "estimated_cost")) || 0), 0);
  const sampleCost = Number(last.llmEstimatedCostUsd);
  const totalCostUsd = +(dbCost || (Number.isFinite(sampleCost) ? sampleCost : 0)).toFixed(6);
  return {
    measurementNote: "API request latency is runner/harness-observed latency under validation polling load, not an isolated production retrieval SLO.",
    apiRequest: latencyStats(apiTimings),
    apiRequestBySegment: Object.fromEntries(Object.entries(apiTimingsBySegment).map(([segment, values]) => [segment, latencyStats(values)])),
    llmOverall: latencyStats(llmLatencies),
    llmAgentP95Ms: Object.fromEntries(Object.entries(byAgent).map(([agent, values]) => [agent, percentile(values, 95)])),
    totals: {
      closedCycles,
      resolvedConflicts,
      netActiveKnowledge,
      totalTokens,
      totalCostUsd,
    },
    ratios: {
      tokensPerClosedCycle: safeDivide(totalTokens, closedCycles),
      costPerClosedCycleUsd: safeDivide(totalCostUsd, closedCycles),
      tokensPerResolvedConflict: safeDivide(totalTokens, resolvedConflicts),
      costPerResolvedConflictUsd: safeDivide(totalCostUsd, resolvedConflicts),
      tokensPerNetActiveKnowledge: safeDivide(totalTokens, netActiveKnowledge),
      costPerNetActiveKnowledgeUsd: safeDivide(totalCostUsd, netActiveKnowledge),
    },
  };
}

export function summarizeHealthSignalQuality({ knowledgeItems = [], events = [], samples = [], llmCalls = [] } = {}) {
  const rssSlope = rssSlopeMbPerHour(samples);
  return {
    generatedAt: new Date().toISOString(),
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    decisionTsr: evaluateDecisionTsr(knowledgeItems),
    resolutionAccuracy: scoreResolutionAccuracy(events),
    latencyAndEfficiency: latencyAndEfficiencyMetrics({ events, samples, llmCalls }),
    rssSlopeMbPerHour: rssSlope,
    rssSlopeThresholdMbPerHour: 50,
    rssSlopeUnder50MbPerHour: rssSlope == null ? null : rssSlope < 50,
  };
}
