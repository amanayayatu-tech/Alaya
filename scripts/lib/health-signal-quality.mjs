export const EXPECTED_EQUITY_THESIS_DECISION = "tiered_thesis";

export const EQUITY_THESIS_ORACLE_BY_SIDE = Object.freeze({
  long_support: {
    oracleSide: "long_support",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "superseded_or_quarantined_when_conflicted",
    scoreableResolutionRule: "long_risk_beats_long_support",
  },
  short_support: {
    oracleSide: "short_support",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "superseded_or_quarantined_when_conflicted",
    scoreableResolutionRule: "short_risk_beats_short_support",
  },
  long_risk: {
    oracleSide: "long_risk",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "retained_over_long_support",
    scoreableResolutionRule: "long_risk_beats_long_support",
  },
  short_risk: {
    oracleSide: "short_risk",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "retained_over_short_support",
    scoreableResolutionRule: "short_risk_beats_short_support",
  },
  tiered_support: {
    oracleSide: "tiered_support",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "retained_as_final_decision",
    scoreableResolutionRule: "tiered_support_beats_tiered_reject",
  },
  tiered_reject: {
    oracleSide: "tiered_reject",
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    expectedDisposition: "quarantined_or_deprecated",
    scoreableResolutionRule: "tiered_support_beats_tiered_reject",
  },
});

const ORACLE_SIDE_PATTERN = /(tiered_support|tiered_reject|long_support|long_risk|short_support|short_risk)/i;
const ACTIVE_STATUSES = new Set(["active", "strong"]);
const NON_CONFLICT_SEED_ID_PREFIXES = ["kb_seed_identity", "kb_seed_world"];
const DISALLOWED_FINAL_DECISIONS = new Set(["long_only", "short_only", "tiered_reject"]);
const NON_FINAL_STATUSES = new Set(["quarantined", "deprecated", "stale", "archived"]);
const CONFLICT_SIDE_SOURCE_PATTERN = /\bsample_\d{4}_(?:tiered_support|tiered_reject|long_support|long_risk|short_support|short_risk)\b/i;
const STRUCTURED_METRIC_THRESHOLD_PATTERN = /\b(?:long_thesis_score|short_thesis_score|bull_thesis_score|bear_thesis_score|tiered_thesis_confidence)\b\s*(?:>=|<=|>|<|=|≥|≤)\s*-?(?:\d+(?:\.\d+)?|\.\d+)/i;
const EXPLICIT_CONFLICT_STATEMENT_PATTERN = /明确冲突|互相矛盾|相互矛盾|结论冲突|推荐冲突|与[^。；;]{0,80}冲突|进入\s*conflict|记录\s*conflict|冲突审查|conflict\s+知识状态|contradict|contradiction/i;
const GOVERNANCE_OR_TASK_RESTATEMENT_PATTERN = /种子身份|种子世界|身份:(?:equity|thesis|investment)|每轮任务|本次验证窗口|本轮应用场景|研究主体|目标标的|投资约束|组合约束|仓位约束|仓位上限|回撤预算|流动性约束|财报窗口|创始人偏好|绝不做|红线|不得绕过|不得把|必须记录\s*conflict|等待人工审核|低置信度|单轮\s*llm|human gate|dry-run|回滚步骤|审计摘要|挂起晋级|流程|任务设定/i;
const RESOLUTION_SIDE_TIERS = Object.freeze({
  tiered_support: 1,
  long_risk: 2,
  short_risk: 2,
  long_support: 3,
  short_support: 3,
  tiered_reject: 4,
});
const RESOLUTION_TIER_LABELS = Object.freeze({
  1: "T1_tiered_support",
  2: "T2_single_side_risk",
  3: "T3_single_side_support",
  4: "T4_tiered_reject",
});
export const RESOLUTION_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD = 0.6;
export const CONFLICT_QUALITY_MIN_ELIGIBLE = 10;
export const LATENCY_SLO_THRESHOLDS_MS = Object.freeze({
  knowledge_retrieval: 2000,
  scheduler_tick: 30000,
});

export function oracleMetadataForSide(side) {
  const normalized = String(side ?? "").toLowerCase();
  return EQUITY_THESIS_ORACLE_BY_SIDE[normalized] ?? null;
}

export function oracleEventFields(side) {
  return oracleMetadataForSide(side) ?? {
    oracleSide: null,
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
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

function knowledgeTags(item) {
  const raw = field(item, "tags");
  if (Array.isArray(raw)) return raw.map((tag) => normalizeLexical(tag)).filter(Boolean);
  const parsed = parseMaybeJson(raw);
  if (Array.isArray(parsed)) return parsed.map((tag) => normalizeLexical(tag)).filter(Boolean);
  return normalizeLexical(raw)
    .split(/[\s,，;；|]+/g)
    .filter(Boolean);
}

function stripFeedbackQuotePrefix(value) {
  return normalizeSpace(value)
    .replace(/^form feedback\s*\([^)]*\)\s*:\s*/i, "")
    .replace(/^recurring market signal unknown from [^:]+:\s*/i, "");
}

function faithfulnessBusinessText(value) {
  const lines = String(value ?? "")
    .split(/[\n\r]+/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (/^human approved meaning gate\b/i.test(line)) continue;
    if (/^source\s*:/i.test(line)) continue;
    if (/^approved via web\b/i.test(line)) continue;
    if (/^librarian merge\s*:/i.test(line)) continue;
    if (/^review\s+kr_[a-z0-9_-]+\s*:/i.test(line)) continue;
    if (/^equity thesis validation human proxy\b/i.test(line)) continue;
    const summary = /^summary\s*:\s*(.+)$/i.exec(line);
    if (summary) {
      kept.push(normalizeSpace(summary[1]));
      continue;
    }
    const quote = /^user quote\s*:\s*(.+)$/i.exec(line);
    if (quote) {
      kept.push(stripFeedbackQuotePrefix(quote[1]));
      continue;
    }
    kept.push(normalizeSpace(line));
  }
  return kept.filter(Boolean).join("\n");
}

function faithfulnessTextForKnowledge(item) {
  return [
    faithfulnessBusinessText(field(item, "title")),
    faithfulnessBusinessText(field(item, "text")),
    faithfulnessBusinessText(field(item, "content")),
  ].filter(Boolean).join("\n");
}

function inferEquityThesisOracleSideFromText(value) {
  const text = normalizeLexical(value);
  if (!text) return null;
  if (/tiered_thesis_confidence\s*(?:<=|<|≤)\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)|反对分层(?:仓位|论点|组合)?[^。；;]{0,120}tiered_thesis_confidence|分层(?:仓位|论点)?反证[^。；;]{0,120}tiered_thesis_confidence/i.test(text)) {
    return "tiered_reject";
  }
  if (/tiered_thesis_confidence\s*(?:>=|>|≥)\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)|(?:核心多头|多头核心|long)[^。；;]{0,120}(?:空头对冲|short|对冲)[^。；;]{0,120}tiered_thesis_confidence/i.test(text)) {
    return "tiered_support";
  }
  if (/看空(?:论点)?(?:风险|反证)|空头(?:风险|反证)|short[^。；;]{0,60}(squeeze|拥挤|挤压|回补|反弹|催化)|当前最优(?:仓位|研判)决策[:：]\s*(?:核心多头|多头核心|多头为主)/i.test(text)) {
    return "short_risk";
  }
  if (/看多(?:论点)?(?:风险|反证)|多头(?:风险|反证)|long[^。；;]{0,60}(估值|下修|回撤|拥挤|盈利)|需要(?:空头|现金|对冲)保护/i.test(text)) {
    return "long_risk";
  }
  if (/当前最优(?:仓位|研判)决策[:：]\s*(?:偏空|做空|优先做空)|(?:看空|空头|short)\s*优先[^。；;]{0,100}(估值|盈利|收入|指引|下修|基本面)|long_thesis_score\s*<=\s*0\.35/i.test(text)) {
    return "short_support";
  }
  if (/当前最优(?:仓位|研判)决策[:：]\s*(?:偏多|做多|优先做多)|(?:看多|多头|long)\s*优先[^。；;]{0,100}(收入|利润|毛利|现金流|基本面|估值修复)|long_thesis_score\s*>=\s*0\.78/i.test(text)) {
    return "long_support";
  }
  return null;
}

function oracleSideForKnowledge(item) {
  return inferOracleSideFromValue(item) ?? inferEquityThesisOracleSideFromText(textForKnowledge(item));
}

function explicitOracleSideForKnowledge(item) {
  return inferOracleSideFromValue({
    oracleSide: field(item, "oracleSide", "oracle_side"),
    side: field(item, "side"),
    primaryOracleSide: field(item, "primaryOracleSide", "primary_oracle_side"),
    relatedOracleSide: field(item, "relatedOracleSide", "related_oracle_side"),
    sourceRef: field(item, "sourceRef", "source_ref"),
    id: field(item, "id"),
    title: field(item, "title"),
    semanticKey: field(item, "semanticKey", "semantic_key"),
    tags: field(item, "tags"),
  });
}

function isSeedIdentityOrWorldKnowledge(item) {
  const id = knowledgeId(item).toLowerCase();
  return NON_CONFLICT_SEED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function isSensorFirewallAuditWrapperKnowledge(item) {
  return knowledgeTags(item).includes("sensor_firewall");
}

function conflictEvidenceText(item) {
  return textForKnowledge(item);
}

function conflictEvidenceSourceText(item) {
  return normalizeLexical([
    field(item, "externalId", "external_id"),
    field(item, "sourceRef", "source_ref"),
    field(item, "id"),
    field(item, "title"),
    field(item, "semanticKey", "semantic_key"),
  ].filter(Boolean).join(" "));
}

function hasStructuredMetricThreshold(value) {
  return STRUCTURED_METRIC_THRESHOLD_PATTERN.test(normalizeLexical(value));
}

function hasExplicitConflictStatement(value) {
  return EXPLICIT_CONFLICT_STATEMENT_PATTERN.test(normalizeLexical(value));
}

function isConflictInjectionPath(item) {
  return CONFLICT_SIDE_SOURCE_PATTERN.test(conflictEvidenceSourceText(item));
}

function isGovernanceOrTaskRestatement(item) {
  const text = conflictEvidenceText(item);
  return GOVERNANCE_OR_TASK_RESTATEMENT_PATTERN.test(text) ||
    knowledgeTags(item).some((tag) => ["identity", "seed", "world", "governance"].includes(tag)) ||
    NON_CONFLICT_SEED_ID_PREFIXES.some((prefix) => supersededByForKnowledge(item).toLowerCase().startsWith(prefix));
}

function scoreableConflictEvidenceGate(item) {
  const text = conflictEvidenceText(item);
  const hasThreshold = hasStructuredMetricThreshold(text);
  const hasConflictSignal = hasExplicitConflictStatement(text) || isConflictInjectionPath(item);
  if (hasThreshold && hasConflictSignal) {
    return { scoreable: true, reason: null };
  }
  return {
    scoreable: false,
    reason: isGovernanceOrTaskRestatement(item) ? "governance_or_task_restatement" : "no_oracle_side",
  };
}

function conflictKnowledgeEligibility(item) {
  if (isSeedIdentityOrWorldKnowledge(item)) {
    return { eligible: false, oracleSide: null, reason: "seed_identity_or_world" };
  }
  if (isSensorFirewallAuditWrapperKnowledge(item)) {
    return { eligible: false, oracleSide: null, reason: "sensor_firewall_audit_wrapper" };
  }
  const evidenceGate = scoreableConflictEvidenceGate(item);
  if (!evidenceGate.scoreable) {
    return { eligible: false, oracleSide: null, reason: evidenceGate.reason };
  }
  const oracleSide = explicitOracleSideForKnowledge(item) ?? inferEquityThesisOracleSideFromText(conflictEvidenceText(item));
  if (!oracleSide) {
    return { eligible: false, oracleSide: null, reason: "no_oracle_side" };
  }
  return { eligible: true, oracleSide, reason: null };
}

function partitionConflictKnowledge(items = []) {
  const eligible = [];
  const excluded = [];
  for (const item of items) {
    const eligibility = conflictKnowledgeEligibility(item);
    if (eligibility.eligible) {
      eligible.push({ item, oracleSide: eligibility.oracleSide });
    } else {
      excluded.push({
        knowledgeId: knowledgeId(item),
        oracleSide: eligibility.oracleSide,
        status: statusForKnowledge(item),
        reason: eligibility.reason,
      });
    }
  }
  return { eligible, excluded };
}

function excludedAsNonConflictSummary(excluded = []) {
  return {
    count: excluded.length,
    reasonCounts: countBy(excluded, (item) => item.reason ?? "unknown"),
    exampleIds: excluded
      .map((item) => item.knowledgeId)
      .filter(Boolean)
      .slice(0, 20),
  };
}

const EQUITY_THESIS_TEMPLATE_CONFIDENCE_BY_SIDE = Object.freeze({
  long_support: 0.64,
  short_support: 0.66,
  long_risk: 0.61,
  short_risk: 0.61,
  tiered_support: 0.71,
  tiered_reject: 0.63,
});

function boundedConfidence(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : null;
}

function structuredConfidence(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    return parsed == null ? null : structuredConfidence(parsed, depth + 1);
  }
  if (typeof value !== "object") return null;
  const record = Array.isArray(value) ? null : value;
  if (record) {
    for (const key of [
      "confidenceScore",
      "confidence_score",
      "confidence",
      "decisionConfidence",
      "decision_confidence",
      "tieredThesisConfidence",
      "tiered_thesis_confidence",
    ]) {
      const confidence = boundedConfidence(record[key]);
      if (confidence != null) return confidence;
    }
  }
  const children = Array.isArray(value)
    ? value
    : [
      value.decision_brief,
      value.payload,
      value.recommended,
      value.recommendation,
      value.prediction,
      value.result,
      value.analysis,
      value.metadata,
    ];
  for (const child of children) {
    const confidence = structuredConfidence(child, depth + 1);
    if (confidence != null) return confidence;
  }
  return null;
}

function confidenceForKnowledge(item) {
  const direct = boundedConfidence(field(item, "confidenceScore", "confidence_score", "confidence"));
  if (direct != null) return direct;
  const text = textForKnowledge(item);
  const match = /(?:置信度|confidence(?:_score)?)\s*[:：]?\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)/i.exec(text);
  if (match) {
    const parsed = boundedConfidence(match[1]);
    if (parsed != null) return parsed;
  }
  for (const source of [
    field(item, "decision_brief", "decisionBrief"),
    field(item, "payload"),
    field(item, "metadata"),
    field(item, "notes"),
    field(item, "tags"),
    field(item, "content"),
    field(item, "text"),
  ]) {
    const confidence = structuredConfidence(source);
    if (confidence != null) return confidence;
  }
  const side = oracleSideForKnowledge(item);
  const sourceText = normalizeLexical([
    field(item, "id"),
    field(item, "sourceRef", "source_ref"),
    field(item, "title"),
  ].filter(Boolean).join(" "));
  if (
    side &&
    EQUITY_THESIS_TEMPLATE_CONFIDENCE_BY_SIDE[side] != null &&
    /equity-thesis-contradiction-runner|sample_\d{4}_|kb_gate_sample|equity_thesis/.test(sourceText)
  ) {
    return EQUITY_THESIS_TEMPLATE_CONFIDENCE_BY_SIDE[side];
  }
  return null;
}

function calibrationTruthFromEvents(events = []) {
  const truths = new Map();
  for (const event of events) {
    const externalId = normalizeSpace(field(event, "externalId", "external_id"));
    const rawTruth = field(event, "calibrationTruth", "calibration_truth");
    if (!externalId || !rawTruth || typeof rawTruth !== "object") continue;
    const mode = String(rawTruth.mode ?? "decision_matches_expected");
    const expectedDecision = normalizeSpace(rawTruth.expectedDecision ?? rawTruth.expected_decision ?? field(event, "expectedDecision", "expected_decision"));
    const expectedOracleSide = normalizeSpace(rawTruth.expectedOracleSide ?? rawTruth.expected_oracle_side ?? field(event, "oracleSide", "oracle_side", "side")).toLowerCase();
    if (!expectedDecision && !expectedOracleSide) continue;
    truths.set(externalId, {
      externalId,
      mode,
      expectedDecision: expectedDecision || null,
      expectedOracleSide: expectedOracleSide || null,
      rationale: normalizeSpace(rawTruth.rationale),
    });
  }
  return truths;
}

function calibrationTruthForKnowledge(item, truths) {
  if (!truths || truths.size === 0) return null;
  const preferredSources = [
    field(item, "sourceRef", "source_ref"),
    field(item, "id"),
    field(item, "title"),
    field(item, "semanticKey", "semantic_key"),
  ];
  for (const source of preferredSources) {
    const text = normalizeSpace(source);
    if (!text) continue;
    for (const [externalId, truth] of truths.entries()) {
      if (text.includes(externalId)) return truth;
    }
  }
  const fallbackText = normalizeSpace([
    field(item, "content"),
    field(item, "notes"),
  ].filter(Boolean).join("\n"));
  for (const [externalId, truth] of truths.entries()) {
    if (fallbackText.includes(externalId)) return truth;
  }
  return null;
}

function actualMatchesCalibrationTruth(item, truth) {
  if (!truth) return null;
  const actualDecision = classifyEquityThesisDecision(item);
  const actualOracleSide = oracleSideForKnowledge(item);
  if (truth.expectedDecision) {
    return {
      correct: actualDecision === truth.expectedDecision,
      actualDecision,
      actualOracleSide,
    };
  }
  if (truth.expectedOracleSide) {
    return {
      correct: actualOracleSide === truth.expectedOracleSide,
      actualDecision,
      actualOracleSide,
    };
  }
  return null;
}

function actualDispositionMatchesOracle(item, oracle) {
  const status = statusForKnowledge(item);
  const supersededBy = supersededByForKnowledge(item);
  const isRetained = ACTIVE_STATUSES.has(status) && !supersededBy;
  const isRemoved = Boolean(supersededBy) || NON_FINAL_STATUSES.has(status);
  switch (oracle?.expectedDisposition) {
    case "retained_as_final_decision":
    case "retained_over_long_support":
    case "retained_over_short_support":
      return isRetained;
    case "superseded_or_quarantined_when_conflicted":
    case "quarantined_or_deprecated":
      return isRemoved;
    default:
      return null;
  }
}

export function classifyEquityThesisDecision(item) {
  const side = oracleSideForKnowledge(item);
  if (side === "long_support") return "long_only";
  if (side === "short_support") return "short_only";
  if (side === "tiered_support" || side === "long_risk" || side === "short_risk") return "tiered_thesis";
  if (side === "tiered_reject") return "tiered_reject";

  const text = textForKnowledge(item);
  if (!text) return "unknown";
  if (/反对分层(?:仓位|论点|组合)?|tiered_reject|tiered_thesis_confidence\s*<=|拒绝(?:空头|现金|对冲)保护|只做单边(?:多头|空头)?|取消分层/i.test(text)) {
    return "tiered_reject";
  }
  if (/多空分层|分层仓位|分层论点|核心多头[^。；;]{0,100}(空头|对冲|现金)|(?:long|多头)[^。；;]{0,80}(?:short|空头|对冲)[^。；;]{0,80}(?:tiered|分层)|仓位分层/i.test(text)) {
    return "tiered_thesis";
  }
  if (/(当前最优(?:仓位|研判)决策[:：]\s*)?(?:优先)?\s*(?:做空|偏空)|(?:看空|空头|short)\s*优先|long_thesis_score\s*<=/i.test(text)) {
    return "short_only";
  }
  if (/(当前最优(?:仓位|研判)决策[:：]\s*)?(?:优先)?\s*(?:做多|偏多)|(?:看多|多头|long)\s*优先|long_thesis_score\s*>=/i.test(text)) {
    return "long_only";
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
    oracleSide: oracleSideForKnowledge(item),
    decision: classifyEquityThesisDecision(item),
    status: statusForKnowledge(item),
  }));
  const decisions = new Set(classified.map((item) => item.decision));
  const disallowed = classified.filter((item) => DISALLOWED_FINAL_DECISIONS.has(item.decision));
  const tiered = classified.filter((item) => item.decision === EXPECTED_EQUITY_THESIS_DECISION);
  const passed = tiered.length > 0 && disallowed.length === 0;
  return {
    status: eligible.length === 0 ? "insufficient_evidence" : (passed ? "pass" : "fail"),
    passed,
    interpretation: "single-scenario pass@1 check: verifies that the final active/strong card state matches the preset equity-thesis oracle; it is not an independent reasoning benchmark",
    passK: normalizePassKAggregate(options.passKAggregate),
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    eligibleKnowledgeCount: eligible.length,
    tieredThesisCount: tiered.length,
    disallowedFinalCount: disallowed.length,
    decisions: Object.fromEntries(Array.from(decisions).sort().map((decision) => [
      decision,
      classified.filter((item) => item.decision === decision).length,
    ])),
    disallowedFinalKnowledge: disallowed,
    tieredThesisKnowledge: tiered.slice(0, 20),
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
  const calibrationTruths = options.calibrationTruths instanceof Map
    ? options.calibrationTruths
    : calibrationTruthFromEvents(options.events ?? []);
  const activeKnowledge = knowledgeItems.filter((item) => ACTIVE_STATUSES.has(statusForKnowledge(item)));
  const { eligible, excluded } = partitionConflictKnowledge(activeKnowledge);
  const excludedAsNonConflict = excludedAsNonConflictSummary(excluded);
  const totalCandidates = activeKnowledge.length;
  const eligibleConflictKnowledgeTotal = eligible.length;
  const scored = [];
  const unscored = [];
  for (const { item, oracleSide } of eligible) {
    const confidence = confidenceForKnowledge(item);
    const oracle = oracleMetadataForSide(oracleSide);
    const truth = calibrationTruthForKnowledge(item, calibrationTruths);
    const truthMatch = actualMatchesCalibrationTruth(item, truth);
    const correct = truthMatch ? truthMatch.correct : actualDispositionMatchesOracle(item, oracle);
    const row = {
      knowledgeId: knowledgeId(item),
      oracleSide,
      status: statusForKnowledge(item),
      supersededBy: supersededByForKnowledge(item) || null,
      confidence,
      expectedDisposition: oracle?.expectedDisposition ?? null,
      correctnessMode: truthMatch ? "calibration_truth_decision" : "oracle_disposition",
      calibrationTruthExternalId: truth?.externalId ?? null,
      expectedDecision: truth?.expectedDecision ?? null,
      actualDecision: truthMatch?.actualDecision ?? null,
      actualOracleSide: truthMatch?.actualOracleSide ?? null,
    };
    if (confidence == null || !oracle || correct == null) {
      unscored.push({
        ...row,
        unscoredReason: confidence == null
          ? "missing_confidence"
          : (!oracle ? "no_oracle" : "correct_null"),
      });
      continue;
    }
    scored.push({ ...row, correct });
  }

  const sampleSize = scored.length;
  const totalEligible = eligibleConflictKnowledgeTotal;
  const scoreableDenominator = eligibleConflictKnowledgeTotal;
  const scoreableCoverage = scoreableDenominator === 0 ? 0 : +(scored.length / scoreableDenominator).toFixed(6);
  const lowCoverage = totalCandidates > 0 && (
    eligibleConflictKnowledgeTotal < CONFLICT_QUALITY_MIN_ELIGIBLE ||
    scoreableCoverage < CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD
  );
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
  if (totalCandidates > 0 && lowCoverage) status = "low_coverage";
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
    totalCandidates,
    eligible: eligibleConflictKnowledgeTotal,
    denominator: scoreableDenominator,
    eligibleConflictKnowledgeTotal,
    minEligible: CONFLICT_QUALITY_MIN_ELIGIBLE,
    totalEligible,
    scoreableDenominator,
    outOfScopeNoOracle: excludedAsNonConflict.reasonCounts.no_oracle_side ?? 0,
    excludedAsNonConflict,
    scoreableCoverage,
    scoreableCoverageThreshold: CALIBRATION_SCOREABLE_COVERAGE_THRESHOLD,
    blockingEligible: sampleSize > 0 && !lowCoverage,
    reliabilityTable,
    correctnessModeCounts: countBy(scored, (item) => item.correctnessMode ?? "unknown"),
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

const FAITHFULNESS_DOMAIN_PHRASES = Object.freeze([
  "看多优先",
  "看空优先",
  "多空分层仓位方案",
  "核心多头 + 空头对冲",
  "核心多头",
  "空头对冲",
  "多头仓位",
  "空头仓位",
  "分层仓位",
  "分层论点",
  "反对分层仓位",
  "单边仓位",
  "看多反证",
  "看空反证",
  "多头风险",
  "空头风险",
  "回撤保护",
  "现金缓冲",
  "仓位上限",
  "止损规则",
  "财报窗口",
  "估值扩张",
  "估值压缩",
  "盈利上修",
  "盈利下修",
  "收入增速",
  "毛利率改善",
  "自由现金流",
  "空头拥挤",
  "short squeeze",
  "回补风险",
  "流动性约束",
  "事件催化",
  "基本面上行",
  "下行风险",
  "风险预算",
  "仓位决策",
  "组合风控",
  "监管披露合规审查",
]);

const FAITHFULNESS_DOMAIN_TERMS = Object.freeze([
  "long",
  "short",
  "tiered",
  "多头",
  "空头",
  "看多",
  "看空",
  "仓位",
  "分层",
  "对冲",
  "估值",
  "盈利",
  "收入",
  "毛利",
  "现金流",
  "回撤",
  "财报",
  "流动性",
  "催化",
  "风控",
  "风险",
  "基本面",
  "组合",
  "分层",
  "置信度",
]);

const FAITHFULNESS_STOP_PHRASES = Object.freeze([
  "当前最优仓位决策",
  "当前最优研判决策",
  "关键证据",
  "明确冲突",
  "建议",
  "新增主张",
  "该结论",
  "该证据",
  "必须",
  "不能",
  "作为",
  "需要",
]);

function compactForSimilarity(value) {
  return normalizeLexical(value).replace(/[^\p{Letter}\p{Number}¥%._+\-<>/=]+/gu, "");
}

function longestCommonSubstringLength(a, b) {
  if (!a || !b) return 0;
  const previous = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    let northwest = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      if (a[i - 1] === b[j - 1]) {
        previous[j] = northwest + 1;
        if (previous[j] > best) best = previous[j];
      } else {
        previous[j] = 0;
      }
      northwest = saved;
    }
  }
  return best;
}

function phraseLooksDomainSpecific(phrase) {
  const normalized = normalizeLexical(phrase);
  if (normalized.length < 4) return false;
  if (FAITHFULNESS_STOP_PHRASES.includes(normalized)) return false;
  return FAITHFULNESS_DOMAIN_TERMS.some((term) => normalized.includes(term));
}

function candidateDomainPhrases(claim) {
  const normalized = normalizeLexical(claim);
  const out = [];
  const chunks = normalized
    .split(/[，,、:：()（）\[\]【】]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  for (const chunk of chunks) {
    const stripped = FAITHFULNESS_STOP_PHRASES.reduce(
      (text, stop) => text.replace(new RegExp(stop, "gu"), " "),
      chunk,
    ).replace(/\s+/g, " ").trim();
    if (phraseLooksDomainSpecific(stripped)) out.push(stripped);
    const words = stripped.split(/\s+/g).filter(Boolean);
    if (words.length >= 2) {
      for (let size = Math.min(5, words.length); size >= 2; size -= 1) {
        for (let index = 0; index + size <= words.length; index += 1) {
          const phrase = words.slice(index, index + size).join(" ");
          if (phraseLooksDomainSpecific(phrase)) out.push(phrase);
        }
      }
    }
  }
  return out;
}

function faithfulnessAnchors(claim) {
  const normalized = normalizeLexical(claim);
  const anchors = [];
  for (const match of normalized.matchAll(/\b[a-z][a-z0-9_]{2,}\s*(?:>=|<=|=|!=|>|<)\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+|\d+(?:\.\d+)?|true|false)\b/g)) {
    anchors.push(match[0]);
  }
  for (const match of normalized.matchAll(/(?:置信度|confidence(?:_score)?)\s*[:：]?\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)/g)) {
    anchors.push(match[0]);
  }
  for (const phrase of FAITHFULNESS_DOMAIN_PHRASES) {
    const anchor = normalizeLexical(phrase);
    if (normalized.includes(anchor)) anchors.push(anchor);
  }
  for (const phrase of candidateDomainPhrases(normalized)) {
    anchors.push(phrase);
  }
  for (const match of normalized.matchAll(/(?:¥\s*)?\b\d+(?:\.\d+)?(?:\s*[-~至到]\s*\d+(?:\.\d+)?)?\s*(?:%|岁|天|元|rmb)?\b/g)) {
    anchors.push(match[0].replace(/\s+/g, ""));
  }
  return Array.from(new Set(anchors
    .map((anchor) => normalizeLexical(anchor))
    .filter((anchor) => anchor && !FAITHFULNESS_STOP_PHRASES.includes(anchor))));
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
  const compactClaim = compactForSimilarity(normalized);
  const bestLcs = Math.max(
    0,
    ...corpusLines.map((line) => longestCommonSubstringLength(compactClaim, compactForSimilarity(line))),
  );
  const bestLcsRatio = compactClaim.length === 0 ? 0 : bestLcs / compactClaim.length;
  const keywordCoverage = anchors.length === 0 ? 0 : supportedAnchors.length / anchors.length;
  const supported = (
    supportedAnchors.length === anchors.length ||
    (numericAnchors.length > 0 && numericAnchors.every((anchor) => corpusJoined.includes(anchor)) && decisiveAnchors.length === 0) ||
    (decisiveAnchors.length > 0 && decisiveAnchors.every((anchor) => corpusJoined.includes(anchor))) ||
    (supportedAnchors.length >= 2 && keywordCoverage >= 0.8) ||
    (bestLcs >= 12 && bestLcsRatio >= 0.72)
  );
  return {
    scoreable: true,
    supported,
    reason: supported ? "anchor_or_similarity_match" : "unsupported_anchor",
    anchors,
    supportedAnchors,
    keywordCoverage: +keywordCoverage.toFixed(6),
    longestCommonSubstring: bestLcs,
    longestCommonSubstringRatio: +bestLcsRatio.toFixed(6),
  };
}

export function evaluateFaithfulness({ knowledgeItems = [], evidenceCorpus = [], events = [], judgeMode = "lexical" } = {}) {
  const activeKnowledge = knowledgeItems.filter((item) => ACTIVE_STATUSES.has(statusForKnowledge(item)));
  const { eligible, excluded } = partitionConflictKnowledge(activeKnowledge);
  const excludedAsNonConflict = excludedAsNonConflictSummary(excluded);
  const totalCandidates = activeKnowledge.length;
  const eligibleConflictKnowledgeTotal = eligible.length;
  const scoreableDenominator = eligibleConflictKnowledgeTotal;

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
      totalCandidates,
      eligible: eligibleConflictKnowledgeTotal,
      denominator: scoreableDenominator,
      eligibleConflictKnowledgeTotal,
      minEligible: CONFLICT_QUALITY_MIN_ELIGIBLE,
      scoreableDenominator,
      scoreableKnowledge: 0,
      scoreableKnowledgeItems: 0,
      claimScoreableCoverage: 0,
      scoreableCoverage: 0,
      scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
      blockingEligible: false,
      unsupportedClaims: [],
      indeterminateReasonCounts: {},
      indeterminateReasons: {},
      excludedAsNonConflict,
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
      totalCandidates,
      eligible: eligibleConflictKnowledgeTotal,
      denominator: scoreableDenominator,
      eligibleConflictKnowledgeTotal,
      minEligible: CONFLICT_QUALITY_MIN_ELIGIBLE,
      scoreableDenominator,
      scoreableKnowledge: 0,
      scoreableKnowledgeItems: 0,
      claimScoreableCoverage: 0,
      scoreableCoverage: 0,
      scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
      blockingEligible: false,
      unsupportedClaims: [],
      indeterminateReasonCounts: {},
      indeterminateReasons: {},
      excludedAsNonConflict,
      note: "No evidence corpus was available from runner templates or contradiction_feedback_injected events.",
    };
  }

  const corpusJoined = corpusLines.join("\n");
  const scoredClaims = [];
  const indeterminateClaims = [];
  const scoreableKnowledgeKeys = new Set();
  for (const [eligibleIndex, { item, oracleSide }] of eligible.entries()) {
    const text = faithfulnessTextForKnowledge(item);
    const itemKey = knowledgeId(item) || `eligible:${eligibleIndex}`;
    for (const claim of splitClaims(text)) {
      const result = scoreFaithfulnessClaim(claim, corpusLines, corpusJoined);
      const row = {
        knowledgeId: knowledgeId(item),
        oracleSide,
        claim,
        reason: result.reason,
        anchors: result.anchors ?? [],
        supportedAnchors: result.supportedAnchors ?? [],
        keywordCoverage: result.keywordCoverage ?? null,
        longestCommonSubstring: result.longestCommonSubstring ?? null,
        longestCommonSubstringRatio: result.longestCommonSubstringRatio ?? null,
      };
      if (!result.scoreable) indeterminateClaims.push(row);
      else {
        scoreableKnowledgeKeys.add(itemKey);
        scoredClaims.push({ ...row, supported: result.supported });
      }
    }
  }

  const supported = scoredClaims.filter((claim) => claim.supported).length;
  const unsupported = scoredClaims.length - supported;
  const totalClaims = scoredClaims.length + indeterminateClaims.length;
  const scoreableKnowledge = scoreableKnowledgeKeys.size;
  const claimScoreableCoverage = totalClaims === 0 ? 0 : +(scoredClaims.length / totalClaims).toFixed(6);
  const scoreableCoverage = scoreableDenominator === 0 ? 0 : +(scoreableKnowledge / scoreableDenominator).toFixed(6);
  const lowCoverage = totalCandidates > 0 && (
    eligibleConflictKnowledgeTotal < CONFLICT_QUALITY_MIN_ELIGIBLE ||
    scoreableCoverage < FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD
  );
  const faithfulness = scoredClaims.length === 0 ? null : +(supported / scoredClaims.length).toFixed(6);
  const hallucinationRate = faithfulness == null ? null : +(1 - faithfulness).toFixed(6);
  let status = "insufficient_evidence";
  if (totalCandidates > 0 && lowCoverage) status = "low_coverage";
  else if (scoredClaims.length > 0 && faithfulness >= 0.95) status = "pass";
  else if (scoredClaims.length > 0 && faithfulness >= 0.9) status = "warn";
  else if (scoredClaims.length > 0) status = "fail";
  const indeterminateReasonCounts = countBy(indeterminateClaims, (claim) => claim.reason ?? "unknown");

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
    totalCandidates,
    eligible: eligibleConflictKnowledgeTotal,
    denominator: scoreableDenominator,
    eligibleConflictKnowledgeTotal,
    minEligible: CONFLICT_QUALITY_MIN_ELIGIBLE,
    scoreableDenominator,
    scoreableKnowledge,
    scoreableKnowledgeItems: scoreableKnowledge,
    claimScoreableCoverage,
    scoreableCoverage,
    scoreableCoverageThreshold: FAITHFULNESS_SCOREABLE_COVERAGE_THRESHOLD,
    blockingEligible: scoredClaims.length > 0 && !lowCoverage,
    unsupportedClaims: scoredClaims.filter((claim) => !claim.supported).slice(0, 50),
    indeterminateReasonCounts,
    indeterminateReasons: indeterminateReasonCounts,
    excludedAsNonConflict,
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
      rule: `tiered_support_beats_${loser}`,
      duplicate: false,
      rationale: "T1 tiered_support 是预置正解本体：核心多头 + 空头/现金对冲的分层仓位，因此在跨层冲突中应保留。",
    };
  }
  if (winnerTier === 2 && loserTier === 3) {
    return {
      winner,
      rule: `${winner}_beats_${loser}`,
      duplicate: false,
      rationale: "T2 风险证据证伪单边多头/空头优先主张，并推动系统走向 tiered_thesis，因此应胜过 T3 单边 support。",
    };
  }
  if (winnerTier === 2 && loserTier === 4) {
    return {
      winner,
      rule: `${winner}_beats_tiered_reject`,
      duplicate: false,
      rationale: "T2 风险证据仍支持分层仓位必要性，而 T4 tiered_reject 反对分层；按 tiered_thesis 正解，T2 应胜过 T4。",
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
    return "ambiguous_t3_support_vs_t4_tiered_reject";
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
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
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

export function summarizeEquityThesisQuality({ knowledgeItems = [], events = [], samples = [], llmCalls = [], evidenceCorpus = [], faithfulnessJudge = "lexical", passKAggregate = null, dedupeMode = "exact", enforceLatencySlo = false } = {}) {
  const rssSlope = rssSlopeMbPerHour(samples);
  return {
    generatedAt: new Date().toISOString(),
    expectedDecision: EXPECTED_EQUITY_THESIS_DECISION,
    decisionTsr: evaluateDecisionTsr(knowledgeItems, { passKAggregate }),
    resolutionAccuracy: scoreResolutionAccuracy(events, { dedupeMode }),
    confidenceCalibration: evaluateConfidenceCalibration(knowledgeItems, { events }),
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
