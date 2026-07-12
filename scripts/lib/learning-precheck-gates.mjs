export const EXCLUDED_COMPRESSED_DURATION_GATES = Object.freeze([
  "single_continuous_24h_directory",
  "metrics_snapshots_at_least_48",
]);
export const EXCLUDED_COMPRESSED_ANALYZER_CHECKS = Object.freeze([
  "durationAtLeast24h",
  "metricsSnapshotsAtLeast48",
]);
export const COMPRESSED_ANALYZER_CLASSIFICATION_SCHEMA = "alaya.learning_loop.compressed_analyzer.v1";
export const REQUIRED_LEARNING_MODEL_CALLING_AGENTS = Object.freeze([
  "orchestrator",
  "sensor",
  "builder",
  "distiller",
  "librarian",
]);
export const CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES = Object.freeze([
  "deltaReached8", "activeNeverZero", "tokenSourceProviderAtLeast95pct",
  "semanticContradictionBypassZero", "conflictAtLeast5", "conflictResolvedAtLeast3",
  "humanGateDropAtLeast30pct", "stallGuardUnder5pct", "sampleFailedZero",
  "durationAtLeast24h", "metricsSnapshotsAtLeast48", "uniqueConstraintErrorsZero",
  "closedDraftingRowsZero", "runnerCrashedZero", "errorLevelEventsZero", "watchdogAllGreen",
  "grayTrendExplained", "countersMonotonic", "snapshotDbGrayMatches",
  "snapshotDbErrorsMatchesOrExceeds", "meaningGateBudgetWithinWeeklyLimit",
  "phase1GrayEventsPresent", "phase2SensorCountersPresent", "phase3ProposalCountersPresent",
  "decisionTsr", "resolutionAccuracy", "confidenceCalibration", "faithfulness",
  "learningCurve", "cumulativeRegret", "knowledgeROI", "learningGovernanceAudit",
  "heldOutAccuracy", "forgettingRate", "latencyAndEfficiency", "rssSlopeUnder50MbPerHour",
]);

const REQUIRED_HELDOUT_BLOCKED_PATHS = Object.freeze([
  "knowledge_retrieval_mutation",
  "feedback_import",
  "distiller",
  "prediction_resolution",
  "knowledge_credit",
  "roi_training",
]);

const ERROR_EVENT_TYPES = Object.freeze({
  schema_error: new Set(["schema_error", "unparseable_jsonl"]),
  parse_error: new Set(["parse_error"]),
  provider_contract_error: new Set(["provider_contract_error", "provider_error"]),
  trace_schema_error: new Set(["trace_schema_error"]),
  analyzer_schema_error: new Set(["analyzer_schema_error"]),
});

function pass(observed) {
  return { status: "PASS", observed };
}

function fail(observed) {
  return { status: "FAIL", observed };
}

function gate(ok, observed) {
  return ok ? pass(observed) : fail(observed);
}

export function computeAnalyzerSourceDigest(parts = []) {
  const hash = createHash("sha256");
  for (const [name, content] of parts) {
    hash.update(String(name));
    hash.update("\0");
    hash.update(Buffer.isBuffer(content) ? content : String(content ?? ""));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function analyzerCheckContract(rows) {
  const names = (rows ?? []).map((entry) => Array.isArray(entry) ? String(entry[0]) : "<invalid>");
  const allowedStatuses = new Set(["PASS", "FAIL", "N/A", "INFO", "LOW_COVERAGE"]);
  const invalidStatuses = (rows ?? []).flatMap((entry) => {
    const name = Array.isArray(entry) ? String(entry[0]) : "<invalid>";
    const status = Array.isArray(entry) ? String(entry[1]?.status ?? "UNKNOWN") : "UNKNOWN";
    return allowedStatuses.has(status) ? [] : [`${name}:${status}`];
  });
  const duplicates = unique(names.filter((name, index) => names.indexOf(name) !== index));
  const missing = CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES.includes(name));
  const exactSequence = sameSequence(names, CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES);
  return {
    status: exactSequence && duplicates.length === 0 && missing.length === 0 && extra.length === 0 && invalidStatuses.length === 0 ? "PASS" : "FAIL",
    expectedNames: [...CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES],
    observedNames: names,
    duplicates,
    missing,
    extra,
    invalidStatuses,
    exactSequence,
  };
}

function analyzerBinding(binding = {}) {
  const invocationNonce = String(binding.invocationNonce ?? "").trim();
  const expectedReplicateId = String(binding.expectedReplicateId ?? "").trim();
  const actualReplicateId = String(binding.actualReplicateId ?? "").trim();
  const generatedAt = String(binding.generatedAt ?? "").trim();
  const sourceDigest = String(binding.sourceDigest ?? "").trim();
  const valid = Boolean(
    invocationNonce && expectedReplicateId && actualReplicateId && expectedReplicateId === actualReplicateId &&
    Number.isFinite(Date.parse(generatedAt)) && sourceDigest.startsWith("sha256:") && sourceDigest.length > 7
  );
  return {
    invocationNonce,
    expectedReplicateId,
    actualReplicateId,
    generatedAt,
    sourceDigest,
    bindingStatus: valid ? "PASS" : "FAIL",
  };
}

export function classifyCompressedAnalyzerChecks(rows = [], binding = {}) {
  const checkContract = analyzerCheckContract(rows);
  const invocation = analyzerBinding(binding);
  const failedNames = (rows ?? [])
    .filter((entry) => Array.isArray(entry) && entry[1]?.status === "FAIL")
    .map((entry) => String(entry[0]));
  const excluded = failedNames.filter((name) => EXCLUDED_COMPRESSED_ANALYZER_CHECKS.includes(name));
  const blocking = failedNames.filter((name) => !EXCLUDED_COMPRESSED_ANALYZER_CHECKS.includes(name));
  return {
    schema: COMPRESSED_ANALYZER_CLASSIFICATION_SCHEMA,
    analysisMode: "compressed-precheck",
    status: blocking.length === 0 && checkContract.status === "PASS" && invocation.bindingStatus === "PASS" ? "PASS" : "FAIL",
    excludedChecks: [...EXCLUDED_COMPRESSED_ANALYZER_CHECKS],
    formalFailureNames: failedNames,
    excludedFailureNames: excluded,
    blockingFailureNames: blocking,
    durationOnlyFormalFailure: failedNames.length > 0 && blocking.length === 0 && excluded.length === failedNames.length && checkContract.status === "PASS" && invocation.bindingStatus === "PASS",
    checkContract,
    checkNames: checkContract.observedNames,
    checkStatuses: Object.fromEntries((rows ?? []).map((entry) => [String(entry[0]), String(entry[1]?.status ?? "UNKNOWN")])),
    ...invocation,
  };
}

export function validCompressedAnalyzerClassification(value, expectation = {}) {
  if (!value || value.schema !== COMPRESSED_ANALYZER_CLASSIFICATION_SCHEMA || value.analysisMode !== "compressed-precheck") return false;
  if (!Array.isArray(value.excludedChecks) || !sameSequence(value.excludedChecks, EXCLUDED_COMPRESSED_ANALYZER_CHECKS)) return false;
  if (!Array.isArray(value.formalFailureNames) || !Array.isArray(value.excludedFailureNames) || !Array.isArray(value.blockingFailureNames)) return false;
  if (!Array.isArray(value.checkNames) || !sameSequence(value.checkNames, CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES)) return false;
  if (value.checkContract?.status !== "PASS" || value.bindingStatus !== "PASS") return false;
  if (!value.checkStatuses || typeof value.checkStatuses !== "object" || Array.isArray(value.checkStatuses)) return false;
  const recomputed = classifyCompressedAnalyzerChecks(
    value.checkNames.map((name) => [name, { status: value.checkStatuses[name] }]),
    {
      invocationNonce: value.invocationNonce,
      expectedReplicateId: value.expectedReplicateId,
      actualReplicateId: value.actualReplicateId,
      generatedAt: value.generatedAt,
      sourceDigest: value.sourceDigest,
    },
  );
  if (recomputed.status !== "PASS" || recomputed.checkContract.status !== "PASS" || recomputed.bindingStatus !== "PASS") return false;
  if (expectation.expectedInvocationNonce && value.invocationNonce !== expectation.expectedInvocationNonce) return false;
  if (expectation.expectedReplicateId && (
    value.expectedReplicateId !== expectation.expectedReplicateId || value.actualReplicateId !== expectation.expectedReplicateId
  )) return false;
  if (expectation.expectedSourceDigest && value.sourceDigest !== expectation.expectedSourceDigest) return false;
  const generatedAtMs = Date.parse(value.generatedAt);
  if (Number.isFinite(expectation.startedAtMs) && generatedAtMs < expectation.startedAtMs) return false;
  if (Number.isFinite(expectation.completedAtMs) && generatedAtMs > expectation.completedAtMs) return false;
  if (Number.isFinite(expectation.startedAtMs) && (
    !Number.isFinite(expectation.classificationMtimeMs) || expectation.classificationMtimeMs < expectation.startedAtMs
  )) return false;
  if (Number.isFinite(expectation.completedAtMs) && expectation.classificationMtimeMs > expectation.completedAtMs) return false;
  return value.blockingFailureNames.length === 0 && value.status === "PASS" &&
    sameSequence(value.formalFailureNames, recomputed.formalFailureNames) &&
    sameSequence(value.excludedFailureNames, recomputed.excludedFailureNames) &&
    sameSequence(value.blockingFailureNames, recomputed.blockingFailureNames) &&
    value.durationOnlyFormalFailure === recomputed.durationOnlyFormalFailure;
}

function unique(values) {
  return Array.from(new Set((values ?? []).filter(Boolean)));
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCount(events, type) {
  const allowed = ERROR_EVENT_TYPES[type];
  return (events ?? []).filter((event) => allowed.has(String(event?.eventType ?? ""))).length;
}

function learningRows(events) {
  return (events ?? [])
    .filter((event) => event?.eventType === "learning_case_resolved")
    .sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0));
}

function scoreable(row) {
  return Boolean(row?.predictedDecision && row?.groundTruthDecision && row?.parseStatus === "ok");
}

function expectedRoute(summary) {
  return {
    provider: String(summary?.llmProvider ?? "").trim(),
    model: String(summary?.model ?? "").trim(),
  };
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function summarizeModelCallInventory({
  modelCalls = [],
  expectedProvider,
  expectedModel,
  declaredRequiredAgents,
} = {}) {
  const calls = (modelCalls ?? []).map((row) => {
    const schemaValidRaw = row?.schemaValid ?? row?.schema_valid;
    const schemaValid = schemaValidRaw === true || Number(schemaValidRaw) === 1;
    const inputTokenCount = finiteNumber(row?.inputTokenCount ?? row?.input_token_count);
    const outputTokenCount = finiteNumber(row?.outputTokenCount ?? row?.output_token_count);
    const tokenCount = finiteNumber(row?.tokenCount ?? row?.token_count);
    const estimatedCost = finiteNumber(row?.estimatedCost ?? row?.estimated_cost);
    const llmFailureType = String(row?.llmFailureType ?? row?.llm_failure_type ?? "").trim() || null;
    const call = {
      id: row?.id ?? null,
      cycleId: String(row?.cycleId ?? row?.cycle_id ?? "").trim() || null,
      agent: String(row?.agent ?? "").trim() || null,
      provider: String(row?.provider ?? "").trim() || null,
      model: String(row?.model ?? "").trim() || null,
      tokenSource: String(row?.tokenSource ?? row?.token_source ?? "").trim() || null,
      schemaValid,
      parseOutcome: schemaValid && !llmFailureType ? "ok" : "error",
      llmFailureType,
      inputTokenCount,
      outputTokenCount,
      tokenCount,
      estimatedCost,
    };
    const missingFields = [];
    for (const field of ["id", "cycleId", "agent", "provider", "model", "tokenSource"]) {
      if (!call[field]) missingFields.push(field);
    }
    for (const field of ["inputTokenCount", "outputTokenCount", "tokenCount", "estimatedCost"]) {
      if (!Number.isFinite(call[field])) missingFields.push(field);
    }
    return { ...call, metadataComplete: missingFields.length === 0, missingFields };
  });
  const required = [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS];
  const declared = Array.isArray(declaredRequiredAgents)
    ? declaredRequiredAgents.map((agent) => String(agent).trim())
    : null;
  const declarationMatches = Array.isArray(declared) && sameSequence(declared, required);
  const observedAgents = unique(calls.map((call) => call.agent));
  const missingAgents = required.filter((agent) => !observedAgents.includes(agent));
  const unexpectedAgents = observedAgents.filter((agent) => !required.includes(agent));
  const routeMatched = calls.filter((call) => call.provider === expectedProvider && call.model === expectedModel).length;
  const tokenSourceProvider = calls.filter((call) => call.tokenSource === "provider").length;
  const unexpectedRouteCallIds = calls
    .filter((call) => call.provider !== expectedProvider || call.model !== expectedModel)
    .map((call) => call.id);
  const missingMetadataCallIds = calls.filter((call) => !call.metadataComplete).map((call) => call.id);
  const schemaFailureCallIds = calls.filter((call) => !call.schemaValid).map((call) => call.id);
  const providerFailureCallIds = calls.filter((call) => call.llmFailureType).map((call) => call.id);
  const providerRouteRatio = calls.length > 0 && expectedProvider && expectedModel ? routeMatched / calls.length : null;
  const tokenSourceProviderRatio = calls.length > 0 ? tokenSourceProvider / calls.length : null;
  const totalTokens = calls.reduce((sum, call) => sum + (call.tokenCount ?? 0), 0);
  const totalCostUsd = calls.reduce((sum, call) => sum + (call.estimatedCost ?? 0), 0);
  const status = calls.length > 0 && expectedProvider && expectedModel && declarationMatches && missingAgents.length === 0 && unexpectedAgents.length === 0 &&
    missingMetadataCallIds.length === 0 && schemaFailureCallIds.length === 0 && providerFailureCallIds.length === 0 &&
    unexpectedRouteCallIds.length === 0
    ? "PASS"
    : "FAIL";
  return {
    schema: "alaya.learning_loop.model_call_inventory.v1",
    status,
    expectedProvider: expectedProvider || null,
    expectedModel: expectedModel || null,
    requiredAgents: required,
    declaredRequiredAgents: declared,
    requiredAgentDeclarationStatus: declarationMatches ? "PASS" : "FAIL",
    observedAgents,
    missingAgents,
    unexpectedAgents,
    callCount: calls.length,
    providerRouteRatio,
    tokenSourceProviderRatio,
    unexpectedRouteCallIds,
    missingMetadataCallIds,
    schemaFailureCallIds,
    providerFailureCallIds,
    usageMetadataComplete: calls.length > 0 && calls.every((call) => call.metadataComplete),
    totals: { totalTokens, totalCostUsd },
    calls,
  };
}

function usageMetadata(summary, qualitySummary, arm, modelCallInventory) {
  const totals = modelCallInventory?.totals ?? qualitySummary?.latencyAndEfficiency?.totals ?? {};
  const tokenStats = summary?.assessment?.observed?.lastLlmTokenSourceStats ?? {};
  return {
    arm,
    replicateId: summary?.scenario?.runId ?? null,
    provider: summary?.llmProvider ?? null,
    model: summary?.model ?? null,
    tokenSource: tokenStats.label ?? null,
    tokenSourceProviderRatio: modelCallInventory?.tokenSourceProviderRatio ?? (Number.isFinite(Number(tokenStats.providerRatio)) ? Number(tokenStats.providerRatio) : null),
    totalTokens: Number.isFinite(Number(totals.totalTokens)) ? Number(totals.totalTokens) : null,
    estimatedOrActualCostUsd: Number.isFinite(Number(totals.totalCostUsd)) ? Number(totals.totalCostUsd) : null,
    modelCallCount: modelCallInventory?.callCount ?? null,
    modelCallUsageComplete: modelCallInventory?.usageMetadataComplete === true,
  };
}

function completeUsage(metadata) {
  return Boolean(
    metadata?.arm &&
    metadata?.replicateId &&
    metadata?.provider &&
    metadata?.model &&
    metadata?.tokenSource &&
    Number.isFinite(metadata?.tokenSourceProviderRatio) &&
    Number.isFinite(metadata?.totalTokens) &&
    Number.isFinite(metadata?.estimatedOrActualCostUsd) &&
    Number.isFinite(metadata?.modelCallCount) && metadata.modelCallCount > 0 &&
    metadata?.modelCallUsageComplete === true,
  );
}

function drillDownComplete(reviews) {
  const verified = (reviews ?? []).filter((review) => (
    review?.verified === true &&
    review?.promptVerified === true &&
    review?.groundTruthVerified === true &&
    review?.modelDecisionVerified === true &&
    review?.scoringVerified === true
  ));
  return { verified: verified.length, required: 10 };
}

function heldoutIsolation(events, qualitySummary, rows) {
  const heldoutRows = rows.filter((row) => row.pool === "heldout");
  const trainRows = rows.filter((row) => row.pool === "train");
  const filterByCase = new Map((events ?? [])
    .filter((event) => event?.eventType === "heldout_write_filter")
    .map((event) => [event.caseId, event]));
  const runtimeInputs = new Set((events ?? [])
    .filter((event) => event?.eventType === "learning_case_runtime_input")
    .map((event) => event.caseId));
  const creditCycles = new Set((events ?? [])
    .filter((event) => event?.eventType === "knowledge_credit" || (event?.eventType === "knowledge_credit_audit" && Number(event.creditEventCount) > 0))
    .map((event) => event.cycleId));
  const roiTrainingIds = new Set(qualitySummary?.knowledgeROI?.trainingOutcomeCaseIds ?? []);
  const violations = [];

  if (qualitySummary?.knowledgeROI?.eligiblePool !== "train") violations.push("knowledgeROI:eligible_pool_not_train");
  for (const row of trainRows) {
    if (!roiTrainingIds.has(row.caseId)) violations.push(`${row.caseId}:missing_roi_training_input`);
  }

  for (const row of heldoutRows) {
    const filter = filterByCase.get(row.caseId);
    const blockedPaths = new Set(filter?.blockedPaths ?? []);
    if (row.excludeFromDistiller !== true || row.excludeFromCreditTraining !== true) violations.push(`${row.caseId}:missing_exclusion_flags`);
    if (!filter || filter.status !== "applied") violations.push(`${row.caseId}:missing_filter_trace`);
    if (filter && !REQUIRED_HELDOUT_BLOCKED_PATHS.every((path) => blockedPaths.has(path))) violations.push(`${row.caseId}:incomplete_blocked_paths`);
    if (filter?.knowledgeStateInvariant?.passed !== true) violations.push(`${row.caseId}:knowledge_state_mutated`);
    if (filter?.knowledgeRetrievalMode !== "read_only" || row?.knowledgeInjection?.retrievalMode !== "read_only") violations.push(`${row.caseId}:retrieval_not_read_only`);
    if (Number(filter?.knowledgeInjectMutationEventCount ?? 0) !== 0) violations.push(`${row.caseId}:inject_audit_mutation`);
    if ((row?.knowledgeInjection?.injectedKnowledgeIds ?? []).length !== 0) violations.push(`${row.caseId}:credit_eligible_injected_ids`);
    if (row?.knowledgeInjection?.creditEligible !== false || row?.knowledgeInjection?.trainingEligible !== false) violations.push(`${row.caseId}:retrieval_learning_eligible`);
    if (filter?.predictionResolutionSkipped !== true) violations.push(`${row.caseId}:prediction_resolved`);
    if (Number(filter?.knowledgeCreditEventCount ?? 0) !== 0 || creditCycles.has(row.cycleId)) violations.push(`${row.caseId}:knowledge_credit`);
    if (runtimeInputs.has(row.caseId)) violations.push(`${row.caseId}:feedback_imported`);
    if (roiTrainingIds.has(row.caseId)) violations.push(`${row.caseId}:roi_training_input`);
  }
  return {
    heldoutCount: heldoutRows.length,
    filterTraceCount: filterByCase.size,
    violations,
  };
}

function governanceComplete(governance) {
  return Boolean(
    governance?.creditAuditComplete === true &&
    governance?.rankingAuditComplete === true &&
    governance?.epsilonAuditComplete === true &&
    Number(governance?.humanStrongBypassCount) === 0 &&
    Number(governance?.pollutedHighRiskInjectionCount) === 0,
  );
}

function evidenceTimestampMs(value) {
  for (const candidate of [value?.ts, value?.timestamp, value?.createdAt, value?.created_at]) {
    if (typeof candidate !== "string" || !candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function optionalFiniteNumber(value) {
  if (value == null || value === "") return null;
  return finiteNumber(value);
}

function evidenceOrder(value, inputIndex, source) {
  return {
    timestampMs: evidenceTimestampMs(value),
    durableId: optionalFiniteNumber(value?.id ?? value?.eventId ?? value?.event_id ?? value?.auditId ?? value?.audit_id),
    cycleIdx: optionalFiniteNumber(value?.cycleIdx ?? value?.cycle_idx) ?? 0,
    inputIndex,
    source,
  };
}

function compareEvidenceOrder(left, right) {
  if (left.timestampMs != null && right.timestampMs != null && left.timestampMs !== right.timestampMs) {
    return left.timestampMs - right.timestampMs;
  }
  if (left.durableId != null && right.durableId != null && left.durableId !== right.durableId) {
    return left.durableId - right.durableId;
  }
  if (left.cycleIdx !== right.cycleIdx) return left.cycleIdx - right.cycleIdx;
  if (left.inputIndex !== right.inputIndex) return left.inputIndex - right.inputIndex;
  return String(left.source).localeCompare(String(right.source));
}

function orderAtOrBefore(candidate, boundary) {
  if (candidate.timestampMs != null && boundary.timestampMs != null) {
    return compareEvidenceOrder(candidate, boundary) <= 0;
  }
  if (candidate.durableId != null && boundary.durableId != null) {
    return compareEvidenceOrder(candidate, boundary) <= 0;
  }
  if (candidate.cycleIdx !== boundary.cycleIdx) return candidate.cycleIdx < boundary.cycleIdx;
  return compareEvidenceOrder(candidate, boundary) <= 0;
}

export function summarizeLearningGovernanceAudit({ auditRows = [], knowledgeRows = [], events = [], arm = "unknown" } = {}) {
  const rows = learningRows(events);
  const creditRows = auditRows.filter((row) => row?.actor === "knowledge_credit" && row?.op === "credit");
  const parsedCredits = creditRows.map((row) => ({
    row,
    before: parseObject(row.before),
    after: parseObject(row.after),
  }));
  const malformedCreditAuditCount = parsedCredits.filter(({ before, after }) => (
    !before.cycleId || !before.knowledgeId || !before.knowledge ||
    !after.cycleId || !after.knowledgeId || !after.knowledge
  )).length;
  const creditKeys = new Set(parsedCredits.map(({ after }) => `${after.cycleId}:${after.knowledgeId}`));
  const expectedCreditKeys = [];
  const unexpectedHeldoutCreditKeys = [];
  for (const row of rows) {
    const injectedIds = row?.knowledgeInjection?.injectedKnowledgeIds ?? [];
    for (const knowledgeId of injectedIds) {
      const key = `${row.cycleId}:${knowledgeId}`;
      if (row.pool === "heldout" || row.excludeFromCreditTraining === true) unexpectedHeldoutCreditKeys.push(key);
      else expectedCreditKeys.push(key);
    }
  }

  const rankingAuditComplete = rows.length > 0 && rows.every((row) => (
    arm === "baseline"
      ? row?.knowledgeInjection?.injectionDisabled === true
      : row?.knowledgeInjection?.rankingMode === "thompson"
  ));
  const epsilonAuditComplete = rows.length > 0 && rows.every((row) => (
    arm === "baseline"
      ? Number(row?.knowledgeInjection?.epsilon) === 0
      : Number(row?.knowledgeInjection?.epsilon) === 0.1
  ));

  const humanStrongBypassRows = auditRows.filter((row) => {
    if (row?.tableName !== "knowledge_items" && row?.table_name !== "knowledge_items") return false;
    const before = parseObject(row.before);
    const after = parseObject(row.after);
    const beforeKnowledge = before.knowledge ?? before;
    const afterKnowledge = after.knowledge ?? after;
    const humanApprovedCount = Number(afterKnowledge.humanApprovedCount ?? afterKnowledge.human_approved_count ?? 0);
    return beforeKnowledge.status !== "strong" && afterKnowledge.status === "strong" &&
      row.actor !== "human" && !(Number.isFinite(humanApprovedCount) && humanApprovedCount >= 1);
  });
  const pollutedStatuses = new Set(["stale", "expired", "quarantined", "conflict"]);
  const historyByKnowledgeId = new Map();
  for (const [auditIndex, audit] of auditRows.entries()) {
    if (audit?.tableName !== "knowledge_items" && audit?.table_name !== "knowledge_items") continue;
    const after = parseObject(audit.after);
    const knowledge = after.knowledge ?? after;
    const id = String(knowledge.id ?? after.knowledgeId ?? "").trim();
    const status = String(knowledge.status ?? "").trim();
    if (!id || !status) continue;
    if (!historyByKnowledgeId.has(id)) historyByKnowledgeId.set(id, []);
    historyByKnowledgeId.get(id).push({
      order: evidenceOrder(audit, auditIndex, "audit"),
      status,
      supersededBy: knowledge.supersededBy ?? knowledge.superseded_by ?? null,
    });
  }
  const pollutedHighRiskInjectionIds = [];
  const eventInputOrder = new Map((events ?? []).map((event, index) => [event, index]));
  for (const [eventIndex, row] of rows.entries()) {
    const injectionOrder = evidenceOrder(row, eventInputOrder.get(row) ?? eventIndex, "learning_case_resolved");
    for (const id of row?.knowledgeInjection?.injectedKnowledgeIds ?? []) {
      const history = (historyByKnowledgeId.get(id) ?? [])
        .filter((entry) => orderAtOrBefore(entry.order, injectionOrder))
        .sort((left, right) => compareEvidenceOrder(left.order, right.order));
      const state = history.at(-1) ?? {};
      if (pollutedStatuses.has(String(state.status ?? "")) || state.supersededBy || state.superseded_by) {
        pollutedHighRiskInjectionIds.push(`${row.cycleId}:${id}`);
      }
    }
  }
  const missingCreditKeys = unique(expectedCreditKeys.filter((key) => !creditKeys.has(key)));
  const heldoutCreditKeys = unique(unexpectedHeldoutCreditKeys.filter((key) => creditKeys.has(key)));

  return {
    status: malformedCreditAuditCount === 0 && missingCreditKeys.length === 0 && heldoutCreditKeys.length === 0 &&
      rankingAuditComplete && epsilonAuditComplete && humanStrongBypassRows.length === 0 && pollutedHighRiskInjectionIds.length === 0
      ? "PASS"
      : "FAIL",
    creditAuditComplete: malformedCreditAuditCount === 0 && missingCreditKeys.length === 0 && heldoutCreditKeys.length === 0,
    creditAuditEventCount: creditRows.length,
    malformedCreditAuditCount,
    missingCreditKeys,
    heldoutCreditKeys,
    rankingAuditComplete,
    epsilonAuditComplete,
    humanStrongBypassCount: humanStrongBypassRows.length,
    pollutedHighRiskInjectionCount: unique(pollutedHighRiskInjectionIds).length,
    pollutedHighRiskInjectionIds: unique(pollutedHighRiskInjectionIds),
    source: "health-signal.db:event_log ordered by timestamp/id/index as-of events.jsonl:learning_case_resolved",
  };
}

export function buildArmPrecheckEvidence({
  arm,
  summary = {},
  qualitySummary = {},
  events = [],
  watchdogRows = [],
  analyzerSchemaErrorCount = 0,
  analyzerArtifactsComplete = false,
  drillDownReviews = [],
  governanceAudit = null,
  analyzerClassification = null,
  analyzerExpectation = null,
  credentialsValid = false,
} = {}) {
  const rows = learningRows(events);
  const route = expectedRoute(summary);
  const modelCallInventory = qualitySummary?.modelCallInventory ?? null;
  const parseErrors = rows.filter((row) => row.parseStatus !== "ok").length;
  const schemaErrors = parseCount(events, "schema_error") + Number(modelCallInventory?.schemaFailureCallIds?.length ?? 0);
  const providerErrors = parseCount(events, "provider_contract_error") + Number(modelCallInventory?.providerFailureCallIds?.length ?? 0);
  const traceErrors = parseCount(events, "trace_schema_error") + rows.filter((row) => (
    row?.binding?.status !== "bound" || !row?.binding?.cycleId || !row?.binding?.predictionId || !row?.knowledgeInjection?.traceEventId
  )).length;
  const errorCounts = {
    schema_error: schemaErrors,
    parse_error: parseErrors + parseCount(events, "parse_error"),
    provider_contract_error: providerErrors,
    trace_schema_error: traceErrors,
    analyzer_schema_error: Number(analyzerSchemaErrorCount) || 0,
  };
  const promptByCase = new Map(events
    .filter((event) => event?.eventType === "learning_case_model_input_audit")
    .map((event) => [event.caseId, event.modelVisiblePrompt]));
  return {
    arm,
    summary,
    qualitySummary,
    rows,
    emittedCaseIds: rows.map((row) => row.caseId),
    route,
    modelCallInventory,
    providerRouteRatio: modelCallInventory?.providerRouteRatio ?? null,
    tokenSourceProviderRatio: modelCallInventory?.tokenSourceProviderRatio ?? null,
    errorCounts,
    drillDown: drillDownComplete(drillDownReviews),
    drillDownCandidates: rows.slice(0, 10).map((row) => ({
      caseId: row.caseId,
      cycleId: row.cycleId,
      prompt: promptByCase.get(row.caseId) ?? null,
      groundTruthDecision: row.groundTruthDecision ?? null,
      modelDecision: row.predictedDecision ?? null,
      parseStatus: row.parseStatus ?? null,
    })),
    isolation: heldoutIsolation(events, qualitySummary, rows),
    watchdog: {
      total: watchdogRows.length,
      bad: watchdogRows.filter((row) => row?.ok !== true).length,
    },
    finalDrain: summary?.finalDrain ?? null,
    governanceAudit,
    analyzerClassification,
    analyzerClassificationValid: Boolean(
      analyzerExpectation && validCompressedAnalyzerClassification(analyzerClassification, analyzerExpectation)
    ),
    analyzerExpectation,
    usageMetadata: usageMetadata(summary, qualitySummary, arm, modelCallInventory),
    credentialsValid,
    analyzerArtifactsComplete,
  };
}

function armGates(evidence, expectedCases) {
  const expectedIds = expectedCases.map((item) => item.id);
  const expectedTruth = new Map(expectedCases.map((item) => [item.id, item.groundTruthDecision]));
  const expectedPool = new Map(expectedCases.map((item) => [item.id, item.pool]));
  const expectedWorldSeed = new Map(expectedCases.map((item) => [item.id, String(item.worldSeed ?? "")]));
  const rows = evidence.rows;
  const scored = rows.filter(scoreable);
  const trainScored = scored.filter((row) => row.pool === "train").length;
  const heldoutScored = scored.filter((row) => row.pool === "heldout").length;
  const scoreableCoverage = rows.length > 0 ? scored.length / rows.length : 0;
  const queue = evidence.finalDrain?.learningCaseQueue;
  const truthRows = rows.filter((row) => (
    row.correctnessMode === "truth" &&
    row?.calibrationTruth?.mode === "decision_matches_expected" &&
    expectedTruth.get(row.caseId) === row.groundTruthDecision &&
    expectedPool.get(row.caseId) === row.pool &&
    expectedWorldSeed.get(row.caseId) === String(row.worldSeed ?? "")
  ));
  const errorsTotal = Object.values(evidence.errorCounts).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    natural_summary_assessment: gate(
      evidence.summary?.assessmentSource === "natural_runtime_summary" && Boolean(evidence.summary?.assessment?.criteria),
      { source: evidence.summary?.assessmentSource ?? null },
    ),
    scored_coverage: gate(
      trainScored >= 60 && heldoutScored >= 20 && scoreableCoverage >= 0.6,
      { trainScored, heldoutScored, scoreableCoverage },
    ),
    truth_correctness_mode: gate(
      rows.length > 0 && truthRows.length === rows.length,
      { truthRows: truthRows.length, totalRows: rows.length },
    ),
    provider_and_token_source: gate(
      evidence.modelCallInventory?.status === "PASS" &&
      evidence.providerRouteRatio === 1 && evidence.tokenSourceProviderRatio != null && evidence.tokenSourceProviderRatio >= 0.95,
      {
        providerRouteRatio: evidence.providerRouteRatio,
        providerRouteThreshold: 1,
        tokenSourceProviderRatio: evidence.tokenSourceProviderRatio,
        tokenSourceProviderThreshold: 0.95,
        inventoryStatus: evidence.modelCallInventory?.status ?? "MISSING",
        callCount: evidence.modelCallInventory?.callCount ?? 0,
        requiredAgents: evidence.modelCallInventory?.requiredAgents ?? [],
        observedAgents: evidence.modelCallInventory?.observedAgents ?? [],
        missingAgents: evidence.modelCallInventory?.missingAgents ?? [],
        unexpectedRouteCallIds: evidence.modelCallInventory?.unexpectedRouteCallIds ?? [],
        missingMetadataCallIds: evidence.modelCallInventory?.missingMetadataCallIds ?? [],
      },
    ),
    error_gates_zero: gate(
      errorsTotal === 0 &&
      evidence.analyzerArtifactsComplete &&
      evidence.analyzerClassificationValid === true,
      {
      ...evidence.errorCounts,
      analyzerArtifactsComplete: evidence.analyzerArtifactsComplete,
      analyzerClassificationStatus: evidence.analyzerClassification?.status ?? "MISSING",
      analyzerBlockingFailureNames: evidence.analyzerClassification?.blockingFailureNames ?? [],
    }),
    manual_drilldown_at_least_10: gate(evidence.drillDown.verified >= evidence.drillDown.required, evidence.drillDown),
    heldout_isolation: gate(evidence.isolation.heldoutCount > 0 && evidence.isolation.violations.length === 0, evidence.isolation),
    watchdog_and_final_drain: gate(
      evidence.watchdog.total > 0 && evidence.watchdog.bad === 0 && evidence.finalDrain?.status === "complete" && queue?.status === "complete" && queue?.queuedCaseCount === 0,
      { watchdog: evidence.watchdog, finalDrainStatus: evidence.finalDrain?.status ?? null, learningCaseQueue: queue ?? null },
    ),
    governance_audit: gate(governanceComplete(evidence.governanceAudit), evidence.governanceAudit),
    usage_metadata: gate(completeUsage(evidence.usageMetadata), evidence.usageMetadata),
    credentials_valid: gate(evidence.credentialsValid === true, { credentialsValid: evidence.credentialsValid }),
    exact_case_sequence: gate(
      expectedIds.length === 120 &&
      evidence.summary?.scenario?.learningCaseCount === 120 &&
      evidence.summary?.scenario?.learningCasesEmitted === 120 &&
      sameSequence(evidence.emittedCaseIds, expectedIds),
      {
        expected: expectedIds.length,
        configured: evidence.summary?.scenario?.learningCaseCount ?? null,
        emitted: evidence.summary?.scenario?.learningCasesEmitted ?? null,
        eventRows: evidence.emittedCaseIds.length,
        missingIds: expectedIds.filter((id) => !evidence.emittedCaseIds.includes(id)),
        duplicateIds: unique(evidence.emittedCaseIds.filter((id, index, all) => all.indexOf(id) !== index)),
      },
    ),
  };
}

export function evaluateCompressedLearningPrecheck({ expectedCases = [], arms = [] } = {}) {
  const byArm = Object.fromEntries(arms.map((evidence) => [evidence.arm, {
    gates: armGates(evidence, expectedCases),
    emittedCaseIds: evidence.emittedCaseIds,
    drillDownCandidates: evidence.drillDownCandidates,
  }]));
  const baselineIds = byArm.baseline?.emittedCaseIds ?? [];
  const treatmentIds = byArm.treatment?.emittedCaseIds ?? [];
  const pairedSequence = gate(
    arms.length === 2 && sameSequence(baselineIds, treatmentIds) && baselineIds.length === 120,
    { baselineCount: baselineIds.length, treatmentCount: treatmentIds.length, identical: sameSequence(baselineIds, treatmentIds) },
  );
  const allArmGates = Object.values(byArm).flatMap((entry) => Object.values(entry.gates));
  const ok = pairedSequence.status === "PASS" && allArmGates.every((entry) => entry.status === "PASS");
  return {
    schema: "alaya.learning_loop.compressed_precheck_gates.v1",
    ok,
    status: ok ? "PASS" : "FAIL",
    evidenceBoundary: "compressed_diagnostic_precheck_only_not_run_l7_formal_acceptance",
    excludedDurationGates: [...EXCLUDED_COMPRESSED_DURATION_GATES],
    legacyConflictChecks: "not_part_of_frozen_prereg_section_5",
    pairedSequence,
    arms: Object.fromEntries(Object.entries(byArm).map(([arm, entry]) => [arm, {
      gates: entry.gates,
      drillDownCandidates: entry.drillDownCandidates,
    }])),
  };
}
import { createHash } from "node:crypto";
