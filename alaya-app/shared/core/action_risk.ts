import type { RiskLevel } from "./types.js";

export interface ActionRiskInput {
  actionType: string;
  target?: string;
  payload?: Record<string, unknown>;
  explicitRiskLevel?: RiskLevel;
}

export interface ApprovalPolicy {
  allowLocalWriteWithoutApproval?: boolean;
}

const RISK_ORDER: RiskLevel[] = [
  "read_only",
  "draft_only",
  "local_write",
  "external_write",
  "destructive",
  "financial",
  "compliance_sensitive",
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function riskAtLeast(actual: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER.indexOf(actual) >= RISK_ORDER.indexOf(floor);
}

function highestRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskAtLeast(a, b) ? a : b;
}

export function normalizeActionPayload(payload: Record<string, unknown> = {}): string {
  return stableStringify(payload);
}

export function makeIdempotencyKey(input: {
  projectId: string;
  cycleId?: string | null;
  actionType: string;
  target?: string;
  payload?: Record<string, unknown>;
}): string {
  const raw = [
    input.projectId,
    input.cycleId ?? "",
    input.actionType.trim().toLowerCase(),
    (input.target ?? "").trim().toLowerCase(),
    normalizeActionPayload(input.payload ?? {}),
  ].join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `idem_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function classifyActionRisk(input: ActionRiskInput): RiskLevel {
  if (input.explicitRiskLevel) return input.explicitRiskLevel;
  const haystack = `${input.actionType} ${input.target ?? ""} ${normalizeActionPayload(input.payload ?? {})}`.toLowerCase();
  let risk: RiskLevel = "read_only";
  if (/\bdraft|preview|dry[-_\s]?run|proposal|plan\b|草稿|预览|计划|方案/.test(haystack)) risk = highestRisk(risk, "draft_only");
  if (/\bwrite|patch|edit|update|insert|create|commit|migration|db:push|local\b|写入|修改|更新|创建|迁移|提交/.test(haystack)) risk = highestRisk(risk, "local_write");
  if (/\bgithub|pull request|issue|api|external|webhook|deploy|publish|send|sync\b|外部|部署|发布|同步|发送/.test(haystack)) risk = highestRisk(risk, "external_write");
  if (/\bdelete|remove|drop|reset|rollback|destructive|irreversible|overwrite|truncate\b|删除|移除|回滚|不可逆|覆盖|清空/.test(haystack)) risk = highestRisk(risk, "destructive");
  if (/\bpayment|invoice|refund|transfer|budget|financial|charge|price\b|支付|发票|退款|转账|预算|财务|收费|价格/.test(haystack)) risk = highestRisk(risk, "financial");
  if (/\bpii|personal|compliance|legal|policy|secret|token|credential|hipaa|gdpr\b|个人信息|合规|法律|策略|密钥|凭据/.test(haystack)) risk = highestRisk(risk, "compliance_sensitive");
  return risk;
}

export function requiresApproval(riskLevel: RiskLevel, policy: ApprovalPolicy = {}): boolean {
  if (riskLevel === "read_only" || riskLevel === "draft_only") return false;
  if (riskLevel === "local_write") return policy.allowLocalWriteWithoutApproval !== true;
  return true;
}

export function actionRiskSummary(input: ActionRiskInput, policy: ApprovalPolicy = {}) {
  const riskLevel = classifyActionRisk(input);
  return {
    riskLevel,
    requiresApproval: requiresApproval(riskLevel, policy),
  };
}
