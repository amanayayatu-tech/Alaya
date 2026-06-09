type GateLike = {
  id: string;
  title: string;
  type: string;
  blocking: number;
  payload?: unknown;
  cycleId?: string | null;
  estimatedMinutes?: number | null;
};

type DecisionAction = "approve" | "reject";

export interface DecisionReceiptContext {
  action: DecisionAction;
  dryRun?: boolean;
  via?: string;
  decidedAt?: Date;
  pendingGatesAfter?: number;
  openConflictReviewsAfter?: number;
  knowledgeId?: string | null;
  projectId?: string;
  rationale?: string;
  callbackWarning?: string;
}

function parsePayload(payload: unknown): Record<string, any> {
  if (!payload) return {};
  if (typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, any>;
  if (typeof payload !== "string") return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compact(value: unknown, max = 360): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = compact(value);
    if (text) return text;
  }
  return "";
}

function gateTypeLabel(gate: GateLike): string {
  if (gate.type === "meaning") return "意义闸";
  if (gate.type === "risk") return "风险闸";
  if (gate.type === "direction") return "方向闸";
  return `${gate.type} 闸门`;
}

function impactForAction(gate: GateLike, action: DecisionAction, knowledgeId?: string | null): string {
  if (gate.type !== "meaning") {
    return action === "approve"
      ? "该闸门将被标记为已批准，相关流程可以继续推进。"
      : "该闸门将被标记为已否决，相关流程不会按原建议继续推进。";
  }

  if (action === "approve") {
    const knowledgePart = knowledgeId ? `知识条目 ${knowledgeId}` : "一条 human_approved meaning knowledge";
    return `批准后会把这条反馈写入或确认到 ${knowledgePart}，并立即参与知识冲突扫描；如果它与既有知识矛盾，系统可能继续生成阻塞型“知识冲突复核”。`;
  }
  return "否决后这条反馈只作为被拒绝的人审记录保留，不会写入 active 知识，也不应参与后续知识复用或冲突收敛。";
}

export function knowledgeIdForMeaningGate(gateId: string): string {
  return `kb_gate_${gateId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 96)}`;
}

export function formatGateDecisionRequestText(gate: GateLike, context: { projectId?: string } = {}): string {
  const payload = parsePayload(gate.payload);
  const summary = firstText(payload.summary, payload.reason, payload.requiredAction, payload.auditSummary?.whyNow, gate.title);
  const userQuote = firstText(payload.userQuote, payload.body, payload.description, payload.redactedBody);
  const source = firstText(payload.sourceName, payload.source, payload.externalId, "unknown source");
  const topic = firstText(payload.topicKey, payload.category, gate.type);
  const reviewReason = firstText(payload.sampleReviewReason, payload.reason, "需要人工判断这条反馈是否足够可靠、相关，并且是否应进入知识库参与后续推理。");
  const project = context.projectId ? `项目 ${context.projectId}` : "当前项目";
  const blocking = gate.blocking === 1 ? "阻塞型" : "非阻塞型";
  const decisionImpact = impactForAction(gate, "approve", gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null);

  return [
    "前情回顾：",
    `${project} 正在运行人审闭环。当前闸门是 ${blocking}${gateTypeLabel(gate)}，来源为 ${source}，主题为 ${topic}。系统把这类反馈作为可能影响知识库和后续推理的证据处理；如果内容与既有结论冲突，批准后还可能继续触发知识冲突复核。`,
    "",
    "本次证据：",
    summary,
    userQuote ? `证据摘录：${userQuote}` : "",
    "",
    "需要决策：",
    `请判断是否允许这条反馈进入当前测试流程。点“批准”表示认可它可作为待审或可复用证据继续参与知识演化；点“否决”表示它不应进入 active 知识路径。${reviewReason}`,
    "",
    "选择影响：",
    `批准：${decisionImpact}`,
    `否决：${impactForAction(gate, "reject")}`,
    "",
    `闸门 ID：${gate.id}`,
  ].filter(Boolean).join("\n");
}

export function formatGateProcessingText(gate: GateLike): string {
  return [
    "正在处理人审决策…",
    `闸门：${gate.title}`,
    `ID：${gate.id}`,
  ].join("\n");
}

export function formatGateDecisionReceiptText(gate: GateLike, context: DecisionReceiptContext): string {
  const payload = parsePayload(gate.payload);
  const label = context.action === "approve" ? "已批准" : "已否决";
  const summary = firstText(payload.summary, payload.reason, payload.requiredAction, gate.title);
  const dryRun = context.dryRun ? "（dry-run，未写入）" : "";
  const decidedAt = context.decidedAt ?? new Date();
  const via = context.via ?? "Telegram";
  const knowledgeId = context.knowledgeId ?? (gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null);
  const pending = Number.isFinite(context.pendingGatesAfter) ? `${context.pendingGatesAfter}` : "未知";
  const reviews = Number.isFinite(context.openConflictReviewsAfter) ? `${context.openConflictReviewsAfter}` : "未知";
  const actionImpact = impactForAction(gate, context.action, knowledgeId);

  return [
    `${label}${dryRun}`,
    "",
    "决策内容：",
    `${label}闸门「${gate.title}」。本次处理的证据摘要是：${summary}`,
    "",
    "系统变化：",
    actionImpact,
    `当前待处理闸门：${pending} 个；开放知识冲突复核：${reviews} 个。`,
    context.rationale ? `处理理由：${context.rationale}` : "",
    "",
    "后续影响：",
    context.action === "approve"
      ? "如果冲突扫描发现它与既有结论相反，下一步需要人工处理 blocking risk gate；否则它会作为已人审证据留在知识库路径中。"
      : "该反馈不会继续推动知识库演化；如后续出现同类证据，需要重新创建闸门再判断。",
    context.callbackWarning ? `\n注意：${context.callbackWarning}` : "",
    "",
    `ID：${gate.id}`,
    `via ${via} · ${decidedAt.toLocaleTimeString("zh-CN")}`,
  ].filter(Boolean).join("\n");
}
