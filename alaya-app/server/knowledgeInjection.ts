import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { rawDb, storage, now } from "./storage";
import type { KnowledgeItem } from "@shared/schema";
import { recordTrace } from "./trace";

const MAX_INJECTED_ITEMS = 5;
const MAX_RECALL_CANDIDATES = 20;
const MAX_APPROX_TOKENS = 800;
const MAX_CONTEXT_CHARS = (MAX_APPROX_TOKENS * 4) - 1;
export type KnowledgeRankingMode = "static" | "thompson";
export type KnowledgeRetrievalMode = "mutating" | "read_only";
export const KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA = "alaya.learning_loop.retrieval_control.v1";

export type KnowledgeRetrievalIdentity = {
  schema: typeof KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA;
  projectId: string;
  runId: string;
  caseId: string;
  cycleId: string;
  mode: KnowledgeRetrievalMode;
};

type KnowledgeRetrievalControl = {
  schema: typeof KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA;
  projectId: string;
  runId: string | null;
  caseId: string | null;
  cycleId: string | null;
  mode: KnowledgeRetrievalMode;
  source: "default" | "scoped_identity" | "scoped_identity_and_control_file";
};

type BuildKnowledgeContextOptions = {
  nowMs?: number;
  maxTokens?: number;
  cycleIdx?: number;
  cycleId?: string;
  agent?: string;
};

const retrievalIdentityScope = new AsyncLocalStorage<KnowledgeRetrievalIdentity>();
const RETRIEVAL_IDENTITY_KEYS = Object.freeze(["caseId", "cycleId", "mode", "projectId", "runId", "schema"]);

type RankedKnowledge = {
  candidates: KnowledgeItem[];
  selected: KnowledgeItem[];
  perItemSample: Record<string, number | null>;
};

export type EpsilonExplorationResult = {
  selected: KnowledgeItem[];
  droppedKnowledgeId: string | null;
  epsilon: number;
  explorationSeed: string;
};

function ftsTerms(input: string): string[] {
  const chunks = input.match(/[\u3400-\u9fff]+|[A-Za-z0-9_]+/g) ?? [];
  const terms: string[] = [];
  for (const chunk of chunks) {
    if (/[\u3400-\u9fff]/.test(chunk)) {
      if (chunk.length <= 2) {
        terms.push(chunk);
      } else {
        for (let i = 0; i < chunk.length - 1; i += 1) {
          terms.push(chunk.slice(i, i + 2));
        }
      }
    } else if (chunk.length >= 2) {
      terms.push(chunk.toLowerCase());
    }
  }
  return Array.from(new Set(terms)).slice(0, 24);
}

function ftsMatchQuery(input: string): string {
  const terms = ftsTerms(input).map((term) => `"${term.replace(/"/g, "")}"*`);
  return terms.join(" OR ");
}

function rowObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  throw new Error("Invalid knowledge_items row");
}

function rowToKnowledge(value: unknown): KnowledgeItem {
  const r = rowObject(value);
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    title: r.title,
    content: r.content,
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    evidenceAlpha: r.evidence_alpha,
    evidenceBeta: r.evidence_beta,
    confidenceScore: r.confidence_score,
    confidenceLevel: r.confidence_level,
    status: r.status,
    humanApprovedCount: r.human_approved_count,
    externalVerifiedCount: r.external_verified_count,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    lastValidatedCycle: r.last_validated_cycle,
    createdByCycle: r.created_by_cycle,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    usageCount: r.usage_count ?? 0,
    lastInjectedAt: r.last_injected_at ?? null,
    lastVerifiedAt: r.last_verified_at ?? null,
    lastDecayedAt: r.last_decayed_at ?? null,
    grayStreak: r.gray_streak ?? 0,
    storageStrength: r.storage_strength ?? 1,
    noveltyScore: r.novelty_score ?? null,
    sourceRound: r.source_round ?? null,
    tags: r.tags,
    notes: r.notes,
    supersededBy: r.superseded_by ?? null,
    semanticKey: r.semantic_key ?? "",
    version: r.version,
  };
}

function searchInjectableKnowledge(projectId: string, taskDescription: string): KnowledgeItem[] {
  const match = ftsMatchQuery(taskDescription);
  if (!match) return [];
  try {
    const rows = rawDb.prepare(`
      SELECT k.*, bm25(knowledge_fts) AS fts_rank
      FROM knowledge_fts
      JOIN knowledge_items k ON k.rowid = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ?
        AND k.project_id = ?
        AND k.status IN ('active', 'strong')
        AND (k.superseded_by IS NULL OR k.superseded_by = '')
      ORDER BY k.confidence_score DESC,
               ((k.evidence_alpha - 1) + (k.evidence_beta - 1)) DESC,
               fts_rank ASC,
               k.id ASC
      LIMIT ?
    `).all(match, projectId, MAX_RECALL_CANDIDATES);
    return rows.map(rowToKnowledge);
  } catch {
    return [];
  }
}

function rankingModeFromEnv(): KnowledgeRankingMode {
  return process.env.ALAYA_KNOWLEDGE_RANKING?.toLowerCase() === "static" ? "static" : "thompson";
}

export function knowledgeInjectionEnabled(): boolean {
  const raw = process.env.ALAYA_KNOWLEDGE_INJECTION;
  if (raw == null || raw.trim() === "") return true;
  return !["0", "false", "off", "disabled", "none"].includes(raw.trim().toLowerCase());
}

function parseRetrievalMode(value: unknown, source: string): KnowledgeRetrievalMode {
  if (value === "mutating" || value === "read_only") return value;
  throw new Error(`Invalid knowledge retrieval mode from ${source}: ${String(value)}`);
}

function requiredIdentityString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`Knowledge retrieval identity ${field} is missing or invalid in ${source}`);
  }
  return value;
}

function parseRetrievalIdentity(value: unknown, source: string): KnowledgeRetrievalIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Knowledge retrieval identity must be one JSON object in ${source}`);
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== RETRIEVAL_IDENTITY_KEYS.length || keys.some((key, index) => key !== RETRIEVAL_IDENTITY_KEYS[index])) {
    throw new Error(`Knowledge retrieval identity keys mismatch in ${source}: ${keys.join(",")}`);
  }
  if (input.schema !== KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA) {
    throw new Error(`Knowledge retrieval identity schema mismatch in ${source}: ${String(input.schema)}`);
  }
  return {
    schema: KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA,
    projectId: requiredIdentityString(input.projectId, "projectId", source),
    runId: requiredIdentityString(input.runId, "runId", source),
    caseId: requiredIdentityString(input.caseId, "caseId", source),
    cycleId: requiredIdentityString(input.cycleId, "cycleId", source),
    mode: parseRetrievalMode(input.mode, source),
  };
}

function retrievalControlFromFile(): KnowledgeRetrievalIdentity | null {
  const controlPath = process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH?.trim();
  if (!controlPath) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(controlPath, "utf8"));
  } catch (error) {
    throw new Error(`Knowledge retrieval control is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRetrievalIdentity(parsed, "control file");
}

function assertRetrievalIdentityMatches(
  expected: KnowledgeRetrievalIdentity,
  observed: KnowledgeRetrievalIdentity,
  source: string,
): void {
  for (const field of RETRIEVAL_IDENTITY_KEYS) {
    if (expected[field as keyof KnowledgeRetrievalIdentity] !== observed[field as keyof KnowledgeRetrievalIdentity]) {
      throw new Error(`Knowledge retrieval identity ${field} mismatch in ${source}`);
    }
  }
}

export function withKnowledgeRetrievalIdentity<T>(
  value: unknown,
  boundary: { projectId: string; cycleId: string },
  callback: () => T,
): T {
  const controlConfigured = Boolean(process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH?.trim());
  if (value == null) {
    if (controlConfigured) throw new Error("A call-scoped knowledge retrieval identity is required when a control mirror is configured");
    return callback();
  }
  const identity = parseRetrievalIdentity(value, "call boundary");
  if (identity.projectId !== boundary.projectId) throw new Error("Knowledge retrieval identity projectId mismatch at call boundary");
  if (identity.cycleId !== boundary.cycleId) throw new Error("Knowledge retrieval identity cycleId mismatch at call boundary");
  const active = retrievalIdentityScope.getStore();
  if (active) assertRetrievalIdentityMatches(identity, active, "nested call scope");
  const controlled = retrievalControlFromFile();
  if (controlled) assertRetrievalIdentityMatches(identity, controlled, "control mirror");
  return retrievalIdentityScope.run(identity, callback);
}

export function resolveKnowledgeRetrievalMode(projectId: string, cycleId?: string): KnowledgeRetrievalControl {
  const scoped = retrievalIdentityScope.getStore();
  const controlConfigured = Boolean(process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH?.trim());
  if (!scoped) {
    if (controlConfigured) throw new Error("A call-scoped knowledge retrieval identity is required when a control mirror is configured");
    return {
      schema: KNOWLEDGE_RETRIEVAL_CONTROL_SCHEMA,
      projectId,
      runId: null,
      caseId: null,
      cycleId: cycleId ?? null,
      mode: "mutating",
      source: "default",
    };
  }
  if (scoped.projectId !== projectId) throw new Error("Knowledge retrieval identity projectId mismatch at buildKnowledgeContext");
  if (!cycleId || scoped.cycleId !== cycleId) throw new Error("Knowledge retrieval identity cycleId mismatch at buildKnowledgeContext");
  const controlled = retrievalControlFromFile();
  if (controlled) assertRetrievalIdentityMatches(scoped, controlled, "buildKnowledgeContext control mirror");
  return {
    ...scoped,
    source: controlled ? "scoped_identity_and_control_file" : "scoped_identity",
  };
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRng(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

function positiveShape(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function sampleStandardNormal(rng: () => number): number {
  const u1 = Math.max(Number.MIN_VALUE, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const boosted = sampleGamma(shape + 1, rng);
    return boosted * Math.pow(Math.max(Number.MIN_VALUE, rng()), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleStandardNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBetaSeeded(alpha: number, beta: number, seed: string): number {
  const rng = seededRng(seed);
  const x = sampleGamma(positiveShape(alpha), rng);
  const y = sampleGamma(positiveShape(beta), rng);
  return x / (x + y);
}

function rankingSeedBase(projectId: string, taskDescription: string, cycleId?: string | null): string {
  const runSeed = process.env.ALAYA_RUN_SEED ?? "alaya-default-run-seed";
  const cycleSeed = cycleId ?? `project:${projectId}:query:${taskDescription}`;
  return `${runSeed}:${cycleSeed}`;
}

function epsilonFromEnv(): number {
  const raw = process.env.ALAYA_INJECTION_EPSILON;
  if (raw == null || raw.trim() === "") return 0.1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0.1;
  return Math.max(0, Math.min(1, parsed));
}

export function rankKnowledgeCandidates(
  candidates: readonly KnowledgeItem[],
  mode: KnowledgeRankingMode,
  seedBase: string,
  limit = MAX_INJECTED_ITEMS,
): RankedKnowledge {
  if (mode === "static") {
    return {
      candidates: [...candidates],
      selected: candidates.slice(0, limit),
      perItemSample: Object.fromEntries(candidates.map((item) => [item.id, null])),
    };
  }

  const sampled = candidates.map((item, index) => ({
    item,
    index,
    sample: sampleBetaSeeded(item.evidenceAlpha, item.evidenceBeta, `${seedBase}:${item.id}`),
  }));
  sampled.sort((a, b) => (b.sample - a.sample) || (a.index - b.index) || a.item.id.localeCompare(b.item.id));
  return {
    candidates: [...candidates],
    selected: sampled.slice(0, limit).map((entry) => entry.item),
    perItemSample: Object.fromEntries(sampled.map((entry) => [entry.item.id, entry.sample])),
  };
}

export function applyEpsilonExploration(
  selected: readonly KnowledgeItem[],
  epsilon: number,
  explorationSeed: string,
): EpsilonExplorationResult {
  const boundedEpsilon = Math.max(0, Math.min(1, Number.isFinite(epsilon) ? epsilon : 0.1));
  if (selected.length === 0 || boundedEpsilon <= 0) {
    return {
      selected: [...selected],
      droppedKnowledgeId: null,
      epsilon: boundedEpsilon,
      explorationSeed,
    };
  }

  const rng = seededRng(explorationSeed);
  if (rng() >= boundedEpsilon) {
    return {
      selected: [...selected],
      droppedKnowledgeId: null,
      epsilon: boundedEpsilon,
      explorationSeed,
    };
  }

  const droppedIndex = Math.min(selected.length - 1, Math.floor(rng() * selected.length));
  const droppedKnowledgeId = selected[droppedIndex]?.id ?? null;
  return {
    selected: selected.filter((_, index) => index !== droppedIndex),
    droppedKnowledgeId,
    epsilon: boundedEpsilon,
    explorationSeed,
  };
}

function compactText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function evidenceCount(item: KnowledgeItem): number {
  return Math.max(0, (item.evidenceAlpha - 1) + (item.evidenceBeta - 1));
}

function formatKnowledgeItem(item: KnowledgeItem, contentChars: number): string {
  const title = compactText(item.title, 120);
  const content = compactText(item.content, contentChars);
  return [
    `- ${item.id} [${item.status}] ${title}`,
    `  score=${item.confidenceScore.toFixed(2)} evidence=${evidenceCount(item).toFixed(1)} usage=${item.usageCount}`,
    `  ${content}`,
  ].join("\n");
}

export function buildKnowledgeContext(
  taskDescription: string,
  projectId: string,
  options: BuildKnowledgeContextOptions = {},
): string {
  const retrieval = resolveKnowledgeRetrievalMode(projectId, options.cycleId);
  if (!knowledgeInjectionEnabled()) {
    const seedBase = rankingSeedBase(projectId, taskDescription, options.cycleId);
    const epsilon = epsilonFromEnv();
    recordTrace({
      projectId,
      cycleId: options.cycleId ?? null,
      cycleIdx: options.cycleIdx ?? null,
      kind: retrieval.mode === "read_only" ? "knowledge_injection_evaluation" : "knowledge_injection",
      name: "build_prior_knowledge_context",
      agent: options.agent ?? "knowledge_injection",
      attributes: {
        injectionDisabled: true,
        knowledgeInjectionMode: "off",
        retrievalMode: retrieval.mode,
        retrievalControlSource: retrieval.source,
        retrievalControlCaseId: retrieval.caseId,
        retrievalControlRunId: retrieval.runId,
        retrievalControlCycleId: retrieval.cycleId,
        persistenceWritesAllowed: false,
        creditEligible: false,
        trainingEligible: false,
        rankingMode: rankingModeFromEnv(),
        perItemSample: {},
        candidateIds: [],
        droppedKnowledgeId: null,
        epsilon,
        explorationSeed: `${seedBase}:exploration`,
        injectedKnowledgeIds: [],
        readOnlySelectedKnowledgeIds: [],
        itemCount: 0,
        maxTokens: options.maxTokens ?? MAX_APPROX_TOKENS,
        taskQueryChars: taskDescription.length,
      },
    });
    return "";
  }

  const candidates = searchInjectableKnowledge(projectId, taskDescription);
  if (candidates.length === 0) {
    const seedBase = rankingSeedBase(projectId, taskDescription, options.cycleId);
    recordTrace({
      projectId,
      cycleId: options.cycleId ?? null,
      cycleIdx: options.cycleIdx ?? null,
      kind: retrieval.mode === "read_only" ? "knowledge_injection_evaluation" : "knowledge_injection",
      name: "build_prior_knowledge_context",
      agent: options.agent ?? "knowledge_injection",
      attributes: {
        injectionDisabled: false,
        knowledgeInjectionMode: "on",
        retrievalMode: retrieval.mode,
        retrievalControlSource: retrieval.source,
        retrievalControlCaseId: retrieval.caseId,
        retrievalControlRunId: retrieval.runId,
        retrievalControlCycleId: retrieval.cycleId,
        persistenceWritesAllowed: retrieval.mode === "mutating",
        creditEligible: false,
        trainingEligible: false,
        rankingMode: rankingModeFromEnv(),
        perItemSample: {},
        candidateIds: [],
        droppedKnowledgeId: null,
        epsilon: epsilonFromEnv(),
        explorationSeed: `${seedBase}:exploration`,
        injectedKnowledgeIds: [],
        readOnlySelectedKnowledgeIds: [],
        itemCount: 0,
        maxTokens: options.maxTokens ?? MAX_APPROX_TOKENS,
        taskQueryChars: taskDescription.length,
      },
    });
    return "";
  }
  const rankingMode = rankingModeFromEnv();
  const ranked = rankKnowledgeCandidates(
    candidates,
    rankingMode,
    rankingSeedBase(projectId, taskDescription, options.cycleId),
  );
  const explorationSeed = `${rankingSeedBase(projectId, taskDescription, options.cycleId)}:exploration`;
  const explored = applyEpsilonExploration(ranked.selected, epsilonFromEnv(), explorationSeed);
  const items = explored.selected;

  const maxChars = Math.max(200, Math.min(options.maxTokens ?? MAX_APPROX_TOKENS, MAX_APPROX_TOKENS) * 4 - 1);
  const included: KnowledgeItem[] = [];
  const lines: string[] = [];
  for (const item of items) {
    const remaining = maxChars - "[PRIOR KNOWLEDGE]\n[/PRIOR KNOWLEDGE]".length - lines.join("\n").length - 1;
    if (remaining < 120) break;
    const rendered = formatKnowledgeItem(item, Math.min(520, Math.max(80, remaining - 180)));
    const candidate = `[PRIOR KNOWLEDGE]\n${[...lines, rendered].join("\n")}\n[/PRIOR KNOWLEDGE]`;
    if (candidate.length > maxChars) break;
    lines.push(rendered);
    included.push(item);
  }

  if (included.length === 0) return "";
  const injectedAt = options.nowMs ?? Date.now();
  if (retrieval.mode === "mutating") {
    for (const item of included) {
      storage.updateKnowledge(item.id, {
        usageCount: item.usageCount + 1,
        lastInjectedAt: injectedAt,
        actor: "knowledge_injection",
      });
      if (options.cycleIdx != null) {
        storage.recordEvent({
          cycleIdx: options.cycleIdx,
          actor: "knowledge_injection",
          tableName: "knowledge_items",
          op: "inject",
          before: null,
          after: JSON.stringify({ id: item.id, projectId, usageCount: item.usageCount + 1 }),
          ts: now(),
        });
      }
    }
  }
  recordTrace({
    projectId,
    cycleId: options.cycleId ?? null,
    cycleIdx: options.cycleIdx ?? null,
    kind: retrieval.mode === "read_only" ? "knowledge_injection_evaluation" : "knowledge_injection",
    name: "build_prior_knowledge_context",
    agent: options.agent ?? "knowledge_injection",
    attributes: {
      injectionDisabled: false,
      knowledgeInjectionMode: "on",
      retrievalMode: retrieval.mode,
      retrievalControlSource: retrieval.source,
      retrievalControlCaseId: retrieval.caseId,
      retrievalControlRunId: retrieval.runId,
      retrievalControlCycleId: retrieval.cycleId,
      persistenceWritesAllowed: retrieval.mode === "mutating",
      creditEligible: retrieval.mode === "mutating",
      trainingEligible: retrieval.mode === "mutating",
      rankingMode,
      perItemSample: ranked.perItemSample,
      candidateIds: ranked.candidates.map((item) => item.id),
      droppedKnowledgeId: explored.droppedKnowledgeId,
      epsilon: explored.epsilon,
      explorationSeed: explored.explorationSeed,
      injectedKnowledgeIds: retrieval.mode === "mutating" ? included.map((item) => item.id) : [],
      readOnlySelectedKnowledgeIds: retrieval.mode === "read_only" ? included.map((item) => item.id) : [],
      itemCount: included.length,
      maxTokens: options.maxTokens ?? MAX_APPROX_TOKENS,
      taskQueryChars: taskDescription.length,
    },
  });
  return `[PRIOR KNOWLEDGE]\n${lines.join("\n")}\n[/PRIOR KNOWLEDGE]`;
}
