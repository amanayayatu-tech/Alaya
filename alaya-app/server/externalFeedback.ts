import { storage, now } from "./storage";
import { callLlm } from "./llm";
import type { Cycle, ExternalFeedbackSource } from "@shared/schema";
import { readFileSync } from "node:fs";

const DEFAULT_GITHUB_TOKEN_FILE = "/private/tmp/alaya-github-token";

const CLASSIFY_SCHEMA = {
  type: "object" as const,
  required: ["summary", "category", "sentiment", "topicKey"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    category: { type: "string" },
    sentiment: { type: "string" },
    topicKey: { type: "string" },
  },
};

type FeedbackCategory = "bug" | "feature_request" | "unclear_signal" | "metric_signal";
type FeedbackSentiment = "positive" | "negative" | "neutral";

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url?: string;
  updated_at?: string;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
  user?: { login?: string };
}

interface GithubConfig {
  owner: string;
  repo: string;
}

interface FormFeedbackInput {
  sourceName?: string;
  externalId?: string;
  title?: string;
  text: string;
  url?: string;
}

export interface SyncGithubIssuesOptions {
  token?: string;
  limit?: number;
}

export interface ExternalFeedbackSyncResult {
  sourceId: string;
  projectId: string;
  cycleId: string;
  owner: string;
  repo: string;
  fetched: number;
  imported: number;
  skipped: number;
  gatesCreated: number;
  errors: string[];
}

export function redactPii(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-phone]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:ghp|github_pat|sk|xox[abprs])_[A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]{8,}/gi, "$1=[redacted-secret]");
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function safeText(input: unknown): string {
  return redactPii(String(input ?? "").trim());
}

function safeErrorMessage(input: unknown): string {
  return safeText(input).slice(0, 500);
}

function readSecretFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function githubToken(explicit?: string): string {
  if (explicit !== undefined) return explicit.trim();
  return [
    process.env.ALAYA_GITHUB_TOKEN,
    process.env.GITHUB_TOKEN,
    readSecretFile(process.env.ALAYA_GITHUB_TOKEN_FILE),
    readSecretFile(process.env.GITHUB_TOKEN_FILE),
    readSecretFile(DEFAULT_GITHUB_TOKEN_FILE),
  ].map((value) => value?.trim() ?? "").find(Boolean) ?? "";
}

function parseConfig(source: ExternalFeedbackSource): GithubConfig {
  const parsed = JSON.parse(source.config || "{}") as Partial<GithubConfig>;
  if (!parsed.owner || !parsed.repo) throw new Error(`GitHub source ${source.id} missing owner/repo`);
  return { owner: parsed.owner, repo: parsed.repo };
}

function parsePayload(payload: string): Record<string, any> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceIdFor(projectId: string, owner: string, repo: string): string {
  return `src_github_${projectId.slice(-6)}_${slug(`${owner}_${repo}`)}`;
}

function feedbackIdFor(projectId: string, owner: string, repo: string, issueNumber: number): string {
  return `fb_github_${projectId.slice(-6)}_${slug(`${owner}_${repo}`)}_${issueNumber}`;
}

function formSourceIdFor(projectId: string, sourceName: string): string {
  return `src_form_${projectId.slice(-6)}_${slug(sourceName) || "form"}`;
}

function formFeedbackIdFor(projectId: string, sourceName: string, externalId: string): string {
  return `fb_form_${projectId.slice(-6)}_${slug(sourceName) || "form"}_${slug(externalId) || Date.now().toString(36)}`;
}

function currentCycleForProject(projectId: string): Cycle | undefined {
  const cycles = storage.listCycles(projectId);
  return cycles.find((c) => c.status !== "closed") ?? cycles[cycles.length - 1];
}

function ensureExternalFeedbackErrorGate(source: ExternalFeedbackSource, cycleId: string, error: string) {
  const existing = storage.listGates(source.projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1 || gate.status !== "pending") return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "external_feedback_sync_error" && payload.sourceId === source.id;
  });
  if (existing) return existing;

  return storage.createGate({
    id: `gate_ext_sync_error_${source.id.replace(/[^a-zA-Z0-9_]+/g, "_")}_${cycleId.slice(-6)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "外部反馈源同步失败",
    payload: JSON.stringify({
      riskKey: "external_feedback_sync_error",
      sourceId: source.id,
      sourceKind: source.kind,
      error,
      createdAt: now(),
      reason: "外部反馈源不可用，不能把本轮无新增反馈解释为真实外部沉默。",
      requiredAction: "检查 GitHub token、仓库权限、API 状态或临时切换到表单/手动反馈输入。",
    }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });
}

function labelNames(issue: GitHubIssue): string[] {
  return (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "").filter(Boolean);
}

function heuristicClassification(issue: GitHubIssue): { category: FeedbackCategory; sentiment: FeedbackSentiment; topicKey: string; summary: string } {
  const labels = labelNames(issue).join(" ").toLowerCase();
  const text = `${issue.title}\n${issue.body ?? ""}`.toLowerCase();
  return heuristicTextClassification(issue.title, issue.body ?? "", labels);
}

function heuristicTextClassification(
  title: string,
  body: string,
  labels = "",
): { category: FeedbackCategory; sentiment: FeedbackSentiment; topicKey: string; summary: string } {
  const text = `${title}\n${body}`.toLowerCase();
  let category: FeedbackCategory = "unclear_signal";
  if (/\bbug|broken|error|fail|crash|regression|does not work\b/.test(`${labels} ${text}`)) category = "bug";
  else if (/\bfeature|request|add|support|wish|enhancement\b/.test(`${labels} ${text}`)) category = "feature_request";
  else if (/\bmetric|activation|conversion|retention|revenue|latency\b/.test(`${labels} ${text}`)) category = "metric_signal";

  let sentiment: FeedbackSentiment = "neutral";
  if (/\bgreat|love|works|thanks|useful|good\b/.test(text)) sentiment = "positive";
  if (/\bbad|broken|hate|fail|blocked|confusing|afraid|scared|worry\b/.test(text)) sentiment = "negative";

  return {
    category,
    sentiment,
    topicKey: slug(labels.split(/\s+/).find(Boolean) || title || category) || category,
    summary: title,
  };
}

function normalizeCategory(value: unknown, fallback: FeedbackCategory): FeedbackCategory {
  return ["bug", "feature_request", "unclear_signal", "metric_signal"].includes(String(value))
    ? String(value) as FeedbackCategory
    : fallback;
}

function normalizeSentiment(value: unknown, fallback: FeedbackSentiment): FeedbackSentiment {
  return ["positive", "negative", "neutral"].includes(String(value))
    ? String(value) as FeedbackSentiment
    : fallback;
}

async function classifyIssue(cycleId: string, source: ExternalFeedbackSource, issue: GitHubIssue) {
  const heuristic = heuristicClassification(issue);
  const redactedBody = safeText(issue.body ?? "");
  const redactedTitle = safeText(issue.title);
  const output = await callLlm({
    cycleId,
    agent: "sensor",
    promptName: "classify_external_feedback",
    inputSummary: `github issue #${issue.number}: ${redactedTitle}`,
    context: {
      sourceId: source.id,
      labels: labelNames(issue),
      title: redactedTitle,
      body: redactedBody,
      allowedCategories: ["bug", "feature_request", "unclear_signal", "metric_signal"],
    },
    schema: CLASSIFY_SCHEMA,
    mockOutput: heuristic,
  });
  return {
    category: normalizeCategory(output.category, heuristic.category),
    sentiment: normalizeSentiment(output.sentiment, heuristic.sentiment),
    topicKey: String(output.topicKey ?? heuristic.topicKey),
    summary: String(output.summary ?? heuristic.summary),
    redactedTitle,
    redactedBody,
  };
}

async function classifyFormFeedback(cycleId: string, source: ExternalFeedbackSource, input: Required<FormFeedbackInput>) {
  const redactedTitle = safeText(input.title);
  const redactedBody = safeText(input.text);
  const heuristic = heuristicTextClassification(redactedTitle || input.sourceName, redactedBody);
  const output = await callLlm({
    cycleId,
    agent: "sensor",
    promptName: "classify_form_feedback",
    inputSummary: `form feedback ${input.sourceName}/${input.externalId}: ${redactedTitle}`,
    context: {
      sourceId: source.id,
      sourceName: input.sourceName,
      title: redactedTitle,
      body: redactedBody,
      allowedCategories: ["bug", "feature_request", "unclear_signal", "metric_signal"],
    },
    schema: CLASSIFY_SCHEMA,
    mockOutput: heuristic,
  });
  return {
    category: normalizeCategory(output.category, heuristic.category),
    sentiment: normalizeSentiment(output.sentiment, heuristic.sentiment),
    topicKey: String(output.topicKey ?? heuristic.topicKey),
    summary: String(output.summary ?? heuristic.summary),
    redactedTitle,
    redactedBody,
  };
}

function issueText(issue: GitHubIssue, title: string, body: string): string {
  const bodyPart = body ? `\n\n${body}` : "";
  return `GitHub Issue #${issue.number}: ${title}${bodyPart}`;
}

export function upsertGithubSource(projectId: string, owner: string, repo: string): ExternalFeedbackSource {
  const config = JSON.stringify({ owner, repo });
  const id = sourceIdFor(projectId, owner, repo);
  const existing = storage.getExternalFeedbackSource(id);
  if (existing) {
    return storage.updateExternalFeedbackSource(id, { config, status: "active" }) ?? existing;
  }
  return storage.createExternalFeedbackSource({
    id,
    projectId,
    kind: "github_issues",
    config,
    status: "active",
    lastSyncedAt: null,
    createdAt: now(),
    version: 1,
  });
}

export function upsertFormFeedbackSource(projectId: string, sourceName = "form"): ExternalFeedbackSource {
  const normalized = sourceName.trim() || "form";
  const id = formSourceIdFor(projectId, normalized);
  const config = JSON.stringify({ sourceName: normalized });
  const existing = storage.getExternalFeedbackSource(id);
  if (existing) {
    return storage.updateExternalFeedbackSource(id, { config, status: "active" }) ?? existing;
  }
  return storage.createExternalFeedbackSource({
    id,
    projectId,
    kind: "form_feedback",
    config,
    status: "active",
    lastSyncedAt: null,
    createdAt: now(),
    version: 1,
  });
}

export async function ingestFormFeedback(projectId: string, input: FormFeedbackInput) {
  const cycle = currentCycleForProject(projectId);
  if (!cycle) throw new Error(`project ${projectId} has no cycle to attach feedback`);
  if (!input.text?.trim()) throw new Error("form feedback text is required");

  const sourceName = input.sourceName?.trim() || "form";
  const externalId = input.externalId?.trim() || `local_${Date.now().toString(36)}`;
  const source = upsertFormFeedbackSource(projectId, sourceName);
  const normalized: Required<FormFeedbackInput> = {
    sourceName,
    externalId,
    title: input.title?.trim() || sourceName,
    text: input.text,
    url: input.url?.trim() || "",
  };
  const feedbackId = formFeedbackIdFor(projectId, sourceName, externalId);
  const existing = storage.getFeedback(feedbackId);
  if (existing) {
    return {
      source,
      feedback: existing,
      gate: storage.getGate(`gate_ext_${feedbackId}`) ?? null,
      classification: null,
      imported: false,
      skipped: true,
    };
  }

  const classification = await classifyFormFeedback(cycle.id, source, normalized);
  const bodyPart = classification.redactedBody ? `\n\n${classification.redactedBody}` : "";
  const text = `Form Feedback (${sourceName} ${externalId}): ${classification.redactedTitle}${bodyPart}`;
  const feedback = storage.createFeedback({
    id: feedbackId,
    cycleId: cycle.id,
    text,
    category: classification.category,
    sentiment: classification.sentiment,
    sourceType: "form_feedback",
    sourceRef: `${sourceName}:${externalId}`,
    sourceUrl: normalized.url,
    topicKey: classification.topicKey,
    summary: classification.summary,
    externalUpdatedAt: now(),
  });

  const gateId = `gate_ext_${feedbackId}`;
  const gate = storage.createGate({
    id: gateId,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: `表单反馈意义闸: ${classification.redactedTitle.slice(0, 36)}`,
    payload: JSON.stringify({
      source: "form_feedback",
      sourceId: source.id,
      sourceName,
      externalId,
      url: normalized.url,
      userQuote: text,
      category: classification.category,
      sentiment: classification.sentiment,
      topicKey: classification.topicKey,
      summary: classification.summary,
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: classification.category === "bug" ? 6 : 8,
    decision: null,
    version: 1,
  });
  storage.updateExternalFeedbackSource(source.id, { lastSyncedAt: now(), status: "active" });
  storage.recordAgentRun({
    cycleId: cycle.id,
    cycleIdx: cycle.idx,
    agent: "sensor",
    action: "ingest_form_feedback",
    outputSummary: `Form ${sourceName}: imported=1, gate=${gate.id}`,
    knowledgeRefsUsed: "[]",
    ts: now(),
  });

  return { source, feedback, gate, classification, imported: true, skipped: false };
}

export async function syncGithubIssuesForSource(
  source: ExternalFeedbackSource,
  cycleId: string,
  options: SyncGithubIssuesOptions = {},
): Promise<ExternalFeedbackSyncResult> {
  const { owner, repo } = parseConfig(source);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const params = new URLSearchParams({ state: "all", sort: "updated", direction: "desc", per_page: String(limit) });
  if (source.lastSyncedAt) params.set("since", source.lastSyncedAt);
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/issues?${params.toString()}`;
  const token = githubToken(options.token);
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "Alaya-Sensor",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const result: ExternalFeedbackSyncResult = {
    sourceId: source.id,
    projectId: source.projectId,
    cycleId,
    owner,
    repo,
    fetched: 0,
    imported: 0,
    skipped: 0,
    gatesCreated: 0,
    errors: [],
  };

  try {
    const response = await fetch(endpoint, { headers });
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${safeErrorMessage(await response.text())}`);
    const issues = await response.json() as GitHubIssue[];
    result.fetched = issues.length;

    for (const issue of issues) {
      if (issue.pull_request) {
        result.skipped++;
        continue;
      }
      const feedbackId = feedbackIdFor(source.projectId, owner, repo, issue.number);
      if (storage.getFeedback(feedbackId)) {
        result.skipped++;
        continue;
      }

      const classification = await classifyIssue(cycleId, source, issue);
      const text = issueText(issue, classification.redactedTitle, classification.redactedBody);
      storage.createFeedback({
        id: feedbackId,
        cycleId,
        text,
        category: classification.category,
        sentiment: classification.sentiment,
        sourceType: "github_issues",
        sourceRef: `github:${owner}/${repo}#${issue.number}`,
        sourceUrl: issue.html_url ?? "",
        topicKey: classification.topicKey,
        summary: classification.summary,
        externalUpdatedAt: issue.updated_at ?? "",
      });
      result.imported++;

      const gateId = `gate_ext_${feedbackId}`;
      if (!storage.getGate(gateId)) {
        storage.createGate({
          id: gateId,
          cycleId,
          type: "meaning",
          blocking: 0,
          title: `外部反馈意义闸: #${issue.number} ${classification.redactedTitle.slice(0, 36)}`,
          payload: JSON.stringify({
            source: "github_issues",
            sourceId: source.id,
            externalId: `github:${owner}/${repo}#${issue.number}`,
            url: issue.html_url ?? "",
            userQuote: text,
            category: classification.category,
            sentiment: classification.sentiment,
            topicKey: classification.topicKey,
            summary: classification.summary,
            createdAt: now(),
          }),
          status: "pending",
          estimatedMinutes: classification.category === "bug" ? 6 : 8,
          decision: null,
          version: 1,
        });
        result.gatesCreated++;
      }
    }

    storage.updateExternalFeedbackSource(source.id, { lastSyncedAt: now(), status: "active" });
    const cycle = storage.getCycle(cycleId);
    storage.recordAgentRun({
      cycleId,
      cycleIdx: cycle?.idx ?? 0,
      agent: "sensor",
      action: "sync_github_issues",
      outputSummary: `GitHub ${owner}/${repo}: fetched=${result.fetched}, imported=${result.imported}, gates=${result.gatesCreated}`,
      knowledgeRefsUsed: "[]",
      ts: now(),
    });
  } catch (err) {
    const message = safeErrorMessage(err instanceof Error ? err.message : String(err));
    result.errors.push(message);
    storage.updateExternalFeedbackSource(source.id, { status: "error" });
    ensureExternalFeedbackErrorGate(source, cycleId, message);
    storage.recordEvent({
      cycleIdx: storage.getCycle(cycleId)?.idx ?? 0,
      actor: "sensor",
      tableName: "external_feedback_sources",
      op: "sync_error",
      before: null,
      after: JSON.stringify({ sourceId: source.id, error: message }),
      ts: now(),
    });
  }

  return result;
}

export async function syncConfiguredFeedbackForProject(projectId: string, cycleId?: string, options: SyncGithubIssuesOptions = {}) {
  const cycle = cycleId ? storage.getCycle(cycleId) : currentCycleForProject(projectId);
  if (!cycle) return [];
  const sources = storage.listExternalFeedbackSources(projectId).filter((s) => s.status !== "disabled" && s.kind === "github_issues");
  const results: ExternalFeedbackSyncResult[] = [];
  for (const source of sources) {
    results.push(await syncGithubIssuesForSource(source, cycle.id, options));
  }
  return results;
}
