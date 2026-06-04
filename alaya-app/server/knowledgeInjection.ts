import { rawDb, storage, now } from "./storage";
import type { KnowledgeItem } from "@shared/schema";
import { recordTrace } from "./trace";

const MAX_INJECTED_ITEMS = 5;
const MAX_APPROX_TOKENS = 800;
const MAX_CONTEXT_CHARS = (MAX_APPROX_TOKENS * 4) - 1;

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

function rowToKnowledge(r: any): KnowledgeItem {
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
    `).all(match, projectId, MAX_INJECTED_ITEMS);
    return rows.map(rowToKnowledge);
  } catch {
    return [];
  }
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
  options: { nowMs?: number; maxTokens?: number; cycleIdx?: number; cycleId?: string; agent?: string } = {},
): string {
  const items = searchInjectableKnowledge(projectId, taskDescription);
  if (items.length === 0) return "";

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
  recordTrace({
    projectId,
    cycleId: options.cycleId ?? null,
    cycleIdx: options.cycleIdx ?? null,
    kind: "knowledge_injection",
    name: "build_prior_knowledge_context",
    agent: options.agent ?? "knowledge_injection",
    attributes: {
      injectedKnowledgeIds: included.map((item) => item.id),
      itemCount: included.length,
      maxTokens: options.maxTokens ?? MAX_APPROX_TOKENS,
      taskQueryChars: taskDescription.length,
    },
  });
  return `[PRIOR KNOWLEDGE]\n${lines.join("\n")}\n[/PRIOR KNOWLEDGE]`;
}
