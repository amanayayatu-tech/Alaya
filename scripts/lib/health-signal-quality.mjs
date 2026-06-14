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
const NON_FINAL_STATUSES = new Set(["quarantined", "deprecated", "stale", "archived"]);
const RESOLUTION_SIDE_TIERS = Object.freeze({
  hybrid_support: 1,
  ppg_risk: 2,
  ecg_risk: 2,
  ppg_support: 3,
  ecg_support: 3,
  hybrid_reject: 4,
});
const RESOLUTION_TIER_LABELS = Object.freeze({
  1: "T1_hybrid_support",
  2: "T2_single_sensor_risk",
  3: "T3_single_sensor_support",
  4: "T4_hybrid_reject",
});
export const RESOLUTION_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const LATENCY_SLO_THRESHOLDS_MS = Object.freeze({
  knowledge_retrieval: 2000,
  scheduler_tick: 30000,
});

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

function normalizeLexical(value) {
  return normalizeSpace(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textForKnowledge(item) {
  return normalizeSpace([
    field(item, "id"),
    field(item, "title"),
    field(item, "text"),
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

function confidenceForKnowledge(item) {
  const raw = field(item, "confidenceScore", "confidence_score", "confidence");
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) return numeric;
  const text = textForKnowledge(item);
  const match = /(?:置信度|confidence(?:_score)?)\s*[:：]?\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)/i.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function actualDispositionMatchesOracle(item, oracle) {
  const status = statusForKnowledge(item);
  const supersededBy = supersededByForKnowledge(item);
  const isRetained = ACTIVE_STATUSES.has(status) && !supersededBy;
  const isRemoved = Boolean(supersededBy) || NON_FINAL_STATUSES.has(status);
  switch (oracle?.expectedDisposition) {
    case "retained_as_final_decision":
    case "retained_over_ppg_support":
    case "retained_over_ecg_support":
      return isRetained;
    case "superseded_or_quarantined_when_conflicted":
    case "quarantined_or_deprecated":
      return isRemoved;
    default:
      return null;
  }
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

export function evaluateDecisionTsr(knowledgeItems = [], options = {}) {
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
    passK: normalizePassKAggregate(options.passKAggregate),
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

function normalizePassKAggregate(passKAggregate) {
  if (!passKAggregate || typeof passKAggregate !== "object") {
    return {
      implemented: false,
      plannedVersion: "v2",
    };
  }
  const k = Number(passKAggregate.k);
  const passAt1 = Number(passKAggregate.passAt1);
  const passPowK = Number(passKAggregate.passPowK);
  if (!Number.isFinite(k) || !Number.isFinite(passAt1) || !Number.isFinite(passPowK)) {
    return {
      implemented: false,
      plannedVersion: "v2",
      status: passKAggregate.status ?? "unavailable",
    };
  }
  return {
    implemented: true,
    k,
    passAt1,
    passPowK,
    status: passKAggregate.status ?? null,
    thresholds: passKAggregate.thresholds ?? { passAt1: 0.85, passPowK: 0.6 },
  };
}

export function evaluateConfidenceCalibration(knowledgeItems = [], options = {}) {
  const bucketCount = Math.max(1, Math.trunc(Number(options.bucketCount ?? 10)));
  const eligible = knowledgeItems.filter((item) => ACTIVE_STATUSES.has(statusForKnowledge(item)));
  const scored = [];
  const unscored = [];
  for (const item of eligible) {
    const confidence = confidenceForKnowledge(item);
    const oracleSide = inferOracleSideFromValue(item);
    const oracle = oracleMetadataForSide(oracleSide);
    const correct = actualDispositionMatchesOracle(item, oracle);
    const row = {
      knowledgeId: knowledgeId(item),
      oracleSide,
      status: statusForKnowledge(item),
      supersededBy: supersededByForKnowledge(item) || null,
      confidence,
      expectedDisposition: oracle?.expectedDisposition ?? null,
    };
    if (confidence == null || !oracle || correct == null) {
      unscored.push({
        ...row,
        unscoredReason: confidence == null
          ? "missing_confidence"
          : (!oracle ? "unknown_oracle_side" : "unknown_expected_disposition"),
      });
      continue;
    }
    scored.push({ ...row, correct });
  }

  const sampleSize = scored.length;
  const totalEligible = scored.length + unscored.length;
  const scoreableCoverage = totalEligible === 0 ? null : +(scored.length / totalEligible).toFixed(6);
  const lowCoverage = scoreableCoverage != null && scoreableCoverage < CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    bucket: index,
    lowerBound: +(index / bucketCount).toFixed(6),
    upperBound: +((index + 1) / bucketCount).toFixed(6),
    rows: [],
  }));
  for (const row of scored) {
    const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor(row.confidence * bucketCount)));
    buckets[bucketIndex].rows.push(row);
  }
  const reliabilityTable = buckets
    .filter((bucket) => bucket.rows.length > 0)
    .map((bucket) => {
      const n = bucket.rows.length;
      const confMean = +(bucket.rows.reduce((sum, row) => sum + row.confidence, 0) / n).toFixed(6);
      const accuracy = +(bucket.rows.filter((row) => row.correct).length / n).toFixed(6);
      return {
        bucket: bucket.bucket,
        lowerBound: bucket.lowerBound,
        upperBound: bucket.upperBound,
        confMean,
        accuracy,
        n,
      };
    });
  const ece = sampleSize === 0
    ? null
    : +reliabilityTable
      .reduce((sum, bucket) => sum + (bucket.n / sampleSize) * Math.abs(bucket.accuracy - bucket.confMean), 0)
      .toFixed(6);

  let status = "insufficient_evidence";
  if (totalEligible > 0 && lowCoverage) status = "low_coverage";
  else if (sampleSize > 0 && ece < 0.05) status = "pass";
  else if (sampleSize > 0 && ece <= 0.1) status = "warn";
  else if (sampleSize > 0) status = "fail";

  return {
    status,
    ece,
    threshold: 0.05,
    warnThreshold: 0.1,
    bucketCount,
    sampleSize,
    scored: scored.length,
    unscored: unscored.length,
    totalEligible,
    scoreableCoverage,
    scoreableCoverageThreshold: CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD,
    blockingEligible: sampleSize > 0 && !lowCoverage,
    reliabilityTable,
    unscoredReasonCounts: countBy(unscored, (item) => item.unscoredReason ?? "unknown"),
    scoredKnowledge: scored.slice(0, 20),
    unscoredExamples: unscored.slice(0, 20),
  };
}

function evidenceCorpusFromEvents(events = []) {
  return events
    .filter((event) => event?.eventType === "contradiction_feedback_injected")
    .flatMap((event) => [
      field(event, "evidenceText", "text", "content", "body"),
      field(event, "evidenceTitle", "title"),
    ])
    .filter((value) => String(value ?? "").trim());
}

function normalizeEvidenceCorpus({ evidenceCorpus = [], events = [] } = {}) {
  const explicit = Array.isArray(evidenceCorpus) ? evidenceCorpus : [evidenceCorpus];
  const source = explicit.some((item) => String(item ?? "").trim())
    ? explicit
    : evidenceCorpusFromEvents(events);
  return source
    .flatMap((item) => {
      if (item == null) return [];
      if (typeof item === "object") {
        return [
          field(item, "text", "content", "body"),
          field(item, "title"),
        ];
      }
      return [item];
    })
    .flatMap((text) => splitClaims(text))
    .map((claim) => normalizeLexical(claim))
    .filter(Boolean);
}

function splitClaims(text) {
  return String(text ?? "")
    .split(/[\n。；;!?！？]+/g)
    .map((claim) => claim.replace(/^[-*•\d\s.)、]+/, "").trim())
    .filter((claim) => claim.length >= 4);
}

function faithfulnessAnchors(claim) {
  const normalized = normalizeLexical(claim);
  const anchors = [];
  for (const match of normalized.matchAll(/\b(?:ppg_priority_score|hybrid_decision_confidence)\s*(?:>=|<=|=)\s*0(?:\.\d+)?\b/g)) {
    anchors.push(match[0]);
  }
  for (const match of normalized.matchAll(/(?:置信度|confidence(?:_score)?)\s*[:：]?\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)/g)) {
    anchors.push(match[0]);
  }
  for (const phrase of [
    "ppg 优先",
    "ecg 优先",
    "ppg+ecg 分层方案",
    "ppg + ecg",
    "混合方案",
    "反对混合方案",
    "ppg 风险",
    "ecg 风险",
    "医疗级判定需要 ecg",
    "nmpa 三类",
    "¥899",
    "7 天续航",
  ]) {
    if (normalized.includes(phrase)) anchors.push(phrase);
  }
  for (const match of normalized.matchAll(/(?:¥\s*)?\b\d+(?:\.\d+)?%?\b/g)) {
    anchors.push(match[0].replace(/\s+/g, ""));
  }
  return Array.from(new Set(anchors.filter(Boolean)));
}

function scoreFaithfulnessClaim(claim, corpusLines, corpusJoined) {
  const normalized = normalizeLexical(claim);
  if (!normalized) return { scoreable: false, supported: false, reason: "empty_claim" };
  if (corpusLines.some((line) => line.includes(normalized)) || corpusJoined.includes(normalized)) {
    return { scoreable: true, supported: true, reason: "exact_or_substring_match" };
  }
  const anchors = faithfulnessAnchors(normalized);
  if (anchors.length === 0) return { scoreable: false, supported: false, reason: "no_deterministic_anchor" };
  const supportedAnchors = anchors.filter((anchor) => corpusJoined.includes(anchor));
  const numericAnchors = anchors.filter((anchor) => /(?:\d|¥)/.test(anchor));
  const decisiveAnchors = anchors.filter((anchor) => !/(?:\b\d|置信度|confidence)/.test(anchor));
  const supported = (
    supportedAnchors.length === anchors.length ||
    (numericAnchors.length > 0 && numericAnchors.every((anchor) => corpusJoined.includes(anchor)) && decisiveAnchors.length === 0) ||
    (decisiveAnchors.length > 0 && decisiveAnchors.every((anchor) => corpusJoined.includes(anchor)))
  );
  return {
    scoreable: true,
    supported,
    reason: supported ? "anchor_match" : "unsupported_anchor",
    anchors,
    supportedAnchors,
  };
}

export function evaluateFaithfulness({ knowledgeItems = [], evidenceCorpus = [], events = [], judgeMode = "lexical" } = {}) {
  if (judgeMode === "llm") {
    return {
      status: "unavailable",
      judgeMode: "llm",
      faithfulness: null,
      hallucinationRate: null,
      threshold: 0.95,
      stretchMedicalTarget: 0.98,
      scored: 0,
      supported: 0,
      unsupported: 0,
      indeterminate: 0,
      totalClaims: 0,
      scoreableCoverage: null,
      scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
      blockingEligible: false,
      unsupportedClaims: [],
      note: "LLM judge mode is reserved for a future claim-level NLI path; default lexical mode makes no LLM calls.",
    };
  }

  const corpusLines = normalizeEvidenceCorpus({ evidenceCorpus, events });
  if (corpusLines.length === 0) {
    return {
      status: "unavailable",
      judgeMode: "lexical",
      faithfulness: null,
      hallucinationRate: null,
      threshold: 0.95,
      stretchMedicalTarget: 0.98,
      scored: 0,
      supported: 0,
      unsupported: 0,
      indeterminate: 0,
      totalClaims: 0,
      evidenceClaimCount: 0,
      scoreableCoverage: null,
      scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
      blockingEligible: false,
      unsupportedClaims: [],
      note: "No evidence corpus was available from runner templates or contradiction_feedback_injected events.",
    };
  }

  const corpusJoined = corpusLines.join("\n");
  const eligible = knowledgeItems.filter((item) => ACTIVE_STATUSES.has(statusForKnowledge(item)));
  const scoredClaims = [];
  const indeterminateClaims = [];
  for (const item of eligible) {
    const text = textForKnowledge(item);
    for (const claim of splitClaims(text)) {
      const result = scoreFaithfulnessClaim(claim, corpusLines, corpusJoined);
      const row = {
        knowledgeId: knowledgeId(item),
        oracleSide: inferOracleSideFromValue(item),
        claim,
        reason: result.reason,
        anchors: result.anchors ?? [],
        supportedAnchors: result.supportedAnchors ?? [],
      };
      if (!result.scoreable) indeterminateClaims.push(row);
      else scoredClaims.push({ ...row, supported: result.supported });
    }
  }

  const supported = scoredClaims.filter((claim) => claim.supported).length;
  const unsupported = scoredClaims.length - supported;
  const totalClaims = scoredClaims.length + indeterminateClaims.length;
  const scoreableCoverage = totalClaims === 0 ? null : +(scoredClaims.length / totalClaims).toFixed(6);
  const lowCoverage = scoreableCoverage != null && scoreableCoverage < FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD;
  const faithfulness = scoredClaims.length === 0 ? null : +(supported / scoredClaims.length).toFixed(6);
  const hallucinationRate = faithfulness == null ? null : +(1 - faithfulness).toFixed(6);
  let status = "insufficient_evidence";
  if (totalClaims > 0 && lowCoverage) status = "low_coverage";
  else if (scoredClaims.length > 0 && faithfulness >= 0.95) status = "pass";
  else if (scoredClaims.length > 0 && faithfulness >= 0.9) status = "warn";
  else if (scoredClaims.length > 0) status = "fail";

  return {
    status,
    judgeMode: "lexical",
    faithfulness,
    hallucinationRate,
    threshold: 0.95,
    stretchMedicalTarget: 0.98,
    scored: scoredClaims.length,
    supported,
    unsupported,
    indeterminate: indeterminateClaims.length,
    totalClaims,
    evidenceClaimCount: corpusLines.length,
    scoreableCoverage,
    scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
    blockingEligible: scoredClaims.length > 0 && !lowCoverage,
    unsupportedClaims: scoredClaims.filter((claim) => !claim.supported).slice(0, 50),
    indeterminateExamples: indeterminateClaims.slice(0, 20),
  };
}

function resolutionTier(side) {
  return RESOLUTION_SIDE_TIERS[side] ?? null;
}

function resolutionPairType(primarySide, relatedSide) {
  return `${primarySide ?? "unknown"}|${relatedSide ?? "unknown"}`;
}

function unorderedResolutionPairType(primarySide, relatedSide) {
  return [primarySide ?? "unknown", relatedSide ?? "unknown"].sort().join("|");
}

function expectedWinnerSide(leftSide, rightSide, { dedupeMode = "exact" } = {}) {
  const leftTier = resolutionTier(leftSide);
  const rightTier = resolutionTier(rightSide);
  if (!leftTier || !rightTier) return null;

  if (leftSide === rightSide) {
    return {
      winner: leftSide,
      rule: dedupeMode === "exact" ? `duplicate_${leftSide}_merge_supersede` : `duplicate_${leftSide}_${dedupeMode}_fallback_merge_supersede`,
      duplicate: true,
      dedupeMode,
      rationale: dedupeMode === "exact"
        ? "同侧 pair 是重复项而非真实业务冲突；期望通过 merge_supersede 去重，quarantine 同侧项会丢失有效证据。"
        : `${dedupeMode} dedupe mode is reserved as a v2 interface; current harness scoring falls back to exact same-side matching without external dependencies.`,
    };
  }

  if (leftTier === rightTier) return null;
  if ((leftTier === 3 && rightTier === 4) || (leftTier === 4 && rightTier === 3)) return null;

  const winner = leftTier < rightTier ? leftSide : rightSide;
  const loser = leftTier < rightTier ? rightSide : leftSide;
  const winnerTier = Math.min(leftTier, rightTier);
  const loserTier = Math.max(leftTier, rightTier);
  if (winnerTier === 1) {
    return {
      winner,
      rule: `hybrid_support_beats_${loser}`,
      duplicate: false,
      rationale: "T1 hybrid_support 是预置正解本体：PPG 连续趋势 + ECG 异常复核/医疗证据补强，因此在跨层冲突中应保留。",
    };
  }
  if (winnerTier === 2 && loserTier === 3) {
    return {
      winner,
      rule: `${winner}_beats_${loser}`,
      duplicate: false,
      rationale: "T2 风险证据证伪单传感器优先主张，并推动系统走向 hybrid_layered，因此应胜过 T3 单传感器 support。",
    };
  }
  if (winnerTier === 2 && loserTier === 4) {
    return {
      winner,
      rule: `${winner}_beats_hybrid_reject`,
      duplicate: false,
      rationale: "T2 风险证据仍支持分层必要性，而 T4 hybrid_reject 反对分层；按 hybrid_layered 正解，T2 应胜过 T4。",
    };
  }
  return null;
}

function unscoredResolutionReason(primarySide, relatedSide) {
  const primaryTier = resolutionTier(primarySide);
  const relatedTier = resolutionTier(relatedSide);
  if (!primaryTier || !relatedTier) return "unknown_oracle_side";
  if (primarySide === relatedSide) return null;
  if (primaryTier === relatedTier) {
    if (primaryTier === 2) return "ambiguous_same_layer_t2_risk_pair";
    if (primaryTier === 3) return "ambiguous_same_layer_t3_support_pair";
    return "ambiguous_same_layer_pair";
  }
  if ((primaryTier === 3 && relatedTier === 4) || (primaryTier === 4 && relatedTier === 3)) {
    return "ambiguous_t3_support_vs_t4_hybrid_reject";
  }
  return "no_deterministic_rule";
}

function actualWinnerSide(event, primarySide, relatedSide) {
  const action = String(event.action ?? "");
  const survivorSide = inferOracleSideFromValue(event.survivorKnowledgeId);
  if (action === "approve_as_current" || action === "reject_conflict") return primarySide;
  if (action === "quarantine" || action === "downgrade_to_stale") return relatedSide;
  if (action === "merge_supersede") return survivorSide ?? relatedSide;
  return null;
}

export function scoreResolutionEvent(event, options = {}) {
  const dedupeMode = options.dedupeMode ?? "exact";
  const primarySide = inferOracleSideFromValue(event.primaryOracleSide ?? event.primarySide ?? event.primaryKnowledgeId);
  const relatedSide = inferOracleSideFromValue(event.relatedOracleSide ?? event.relatedSide ?? event.relatedKnowledgeId);
  const expected = expectedWinnerSide(primarySide, relatedSide, { dedupeMode });
  const actual = actualWinnerSide(event, primarySide, relatedSide);
  const action = String(event.action ?? "");
  const scoreable = Boolean(expected && (expected.duplicate || actual));
  const duplicateCorrect = expected?.duplicate ? action === "merge_supersede" : null;
  return {
    reviewId: event.reviewId ?? null,
    primaryKnowledgeId: event.primaryKnowledgeId ?? null,
    relatedKnowledgeId: event.relatedKnowledgeId ?? null,
    action: event.action ?? null,
    oracleSide: primarySide,
    relatedOracleSide: relatedSide,
    primaryOracleSide: primarySide,
    resolutionPairType: resolutionPairType(primarySide, relatedSide),
    resolutionUnorderedPairType: unorderedResolutionPairType(primarySide, relatedSide),
    primaryResolutionTier: primarySide ? RESOLUTION_TIER_LABELS[resolutionTier(primarySide)] ?? null : null,
    relatedResolutionTier: relatedSide ? RESOLUTION_TIER_LABELS[resolutionTier(relatedSide)] ?? null : null,
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    expectedDisposition: primarySide ? oracleMetadataForSide(primarySide)?.expectedDisposition ?? null : null,
    dedupeMode,
    scoreableResolutionRule: expected?.rule ?? null,
    scoreableResolutionRationale: expected?.rationale ?? null,
    resolutionUnscoredReason: expected ? null : unscoredResolutionReason(primarySide, relatedSide),
    resolutionDuplicatePair: Boolean(expected?.duplicate),
    resolutionExpectedAction: expected?.duplicate ? "merge_supersede" : null,
    resolutionScoreable: scoreable,
    resolutionExpectedWinnerSide: expected?.winner ?? null,
    resolutionActualWinnerSide: actual,
    resolutionCorrect: scoreable ? (expected.duplicate ? duplicateCorrect : expected.winner === actual) : null,
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function scoreResolutionAccuracy(events = [], options = {}) {
  const dedupeMode = options.dedupeMode ?? "exact";
  const resolutionEvents = events.filter((event) => event?.eventType === "knowledge_review_resolved");
  const scored = [];
  const unscored = [];
  for (const event of resolutionEvents) {
    const result = scoreResolutionEvent(event, { dedupeMode });
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
    dedupeMode,
    pairTypeCounts: countBy([...scored, ...unscored], (item) => item.resolutionUnorderedPairType),
    scoredPairTypeCounts: countBy(scored, (item) => item.resolutionUnorderedPairType),
    unscoredPairTypeCounts: countBy(unscored, (item) => item.resolutionUnorderedPairType),
    unscoredReasonCounts: countBy(unscored, (item) => item.resolutionUnscoredReason ?? "unknown"),
    duplicatePairTypeCounts: countBy(scored.filter((item) => item.resolutionDuplicatePair), (item) => item.resolutionUnorderedPairType),
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

function latencySlo(apiRequestBySegment, { enforceLatencySlo = false } = {}) {
  const segments = Object.entries(LATENCY_SLO_THRESHOLDS_MS).map(([segment, p95ThresholdMs]) => {
    const stats = apiRequestBySegment[segment] ?? latencyStats([]);
    const p95Ms = stats.p95Ms;
    let status = "unavailable";
    if (p95Ms != null) {
      if (p95Ms < p95ThresholdMs) status = "pass";
      else if (p95Ms < p95ThresholdMs * 1.25) status = "warn";
      else status = "fail";
    }
    return {
      segment,
      sampleSize: stats.sampleSize,
      p95Ms,
      p95ThresholdMs,
      status,
    };
  });
  const measured = segments.filter((segment) => segment.status !== "unavailable");
  let sloStatus = "unavailable";
  if (measured.length > 0) {
    if (measured.some((segment) => segment.status === "fail")) sloStatus = "fail";
    else if (measured.some((segment) => segment.status === "warn")) sloStatus = "warn";
    else sloStatus = "pass";
  }
  return {
    sloStatus,
    sloBlocking: Boolean(enforceLatencySlo && sloStatus === "fail"),
    enforceLatencySlo: Boolean(enforceLatencySlo),
    thresholdsMs: LATENCY_SLO_THRESHOLDS_MS,
    includedSegments: segments,
    excludedSegments: ["harness_polling_api_request"],
    measurementNote: "harness_polling_api_request is excluded: harness polling is not a production SLO; knowledge_retrieval and scheduler_tick are SLO-observed segments.",
  };
}

export function latencyAndEfficiencyMetrics({ events = [], samples = [], llmCalls = [], enforceLatencySlo = false } = {}) {
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
  const apiRequestBySegment = Object.fromEntries(Object.entries(apiTimingsBySegment).map(([segment, values]) => [segment, latencyStats(values)]));
  return {
    measurementNote: "API request latency is runner/harness-observed latency under validation polling load, not an isolated production retrieval SLO.",
    apiRequest: latencyStats(apiTimings),
    apiRequestBySegment,
    slo: latencySlo(apiRequestBySegment, { enforceLatencySlo }),
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

export function summarizeHealthSignalQuality({ knowledgeItems = [], events = [], samples = [], llmCalls = [], evidenceCorpus = [], faithfulnessJudge = "lexical", passKAggregate = null, dedupeMode = "exact", enforceLatencySlo = false } = {}) {
  const rssSlope = rssSlopeMbPerHour(samples);
  return {
    generatedAt: new Date().toISOString(),
    expectedDecision: EXPECTED_HEALTH_SIGNAL_DECISION,
    decisionTsr: evaluateDecisionTsr(knowledgeItems, { passKAggregate }),
    resolutionAccuracy: scoreResolutionAccuracy(events, { dedupeMode }),
    confidenceCalibration: evaluateConfidenceCalibration(knowledgeItems),
    faithfulness: evaluateFaithfulness({ knowledgeItems, events, evidenceCorpus, judgeMode: faithfulnessJudge }),
    latencyAndEfficiency: latencyAndEfficiencyMetrics({ events, samples, llmCalls, enforceLatencySlo }),
    rssSlopeMbPerHour: rssSlope,
    rssSlopeThresholdMbPerHour: 50,
    rssSlopeUnder50MbPerHour: rssSlope == null ? null : rssSlope < 50,
    notes: [
      {
        type: "benchmark_mapping",
        decisionTsr: "task-success-rate style single-scenario oracle check, similar to tau-bench pass@1/pass^k reliability framing",
        resolutionAccuracy: "conflict resolution / implicit inference accuracy over deterministic oracle pair rules",
        faithfulness: "claim-level lexical NLI proxy for RAGAS/TruLens-style faithfulness; LLM judge interface is reserved but off by default",
        confidenceCalibration: "expected calibration error / reliability table over confidence_score or extracted confidence text",
      },
    ],
  };
}
