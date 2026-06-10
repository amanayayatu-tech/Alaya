import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import type { KnowledgeItem, KnowledgeReviewItem } from "@shared/schema";
import { recordActionProposal } from "./actionLedger";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";
import { setKnowledgeConflictDetector } from "./knowledgeConflictHooks";
import { HumanGateService } from "./humanGateService";
import { createDecisionBrief, withDecisionBriefPayload } from "./decisionBrief";

type ReviewAction = "approve_as_current" | "quarantine" | "merge_supersede" | "downgrade_to_stale" | "reject_conflict";

export interface ConflictCandidate {
  primaryKnowledgeId: string;
  relatedKnowledgeId: string;
  reason: string;
  evidence: Record<string, unknown>;
  recommendedAction: string;
}

export interface KnowledgeReminderOptions {
  nowMs?: number;
  staleAfterDays?: number;
  expiryWithinDays?: number;
}

export interface ResolveKnowledgeReviewInput {
  action: ReviewAction;
  actor?: string;
  rationale?: string;
  survivorKnowledgeId?: string;
}

export interface ResolvedConflictSurvivorViolation {
  reviewId: string;
  projectId: string;
  knowledgeIds: string[];
  reason: string;
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isOnboardingSeedKnowledge(item: KnowledgeItem): boolean {
  const tags = parseTags(item.tags).map((tag) => tag.toLowerCase());
  return item.id.startsWith("kb_seed_") || item.sourceRef === "onboarding" || tags.includes("seed");
}

function normalizeKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u3000\s]+/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim()
    .slice(0, 160);
}

function knowledgeKey(item: KnowledgeItem): string {
  return normalizeKey(item.semanticKey || item.title);
}

function knowledgeText(item: KnowledgeItem): string {
  return [
    item.title,
    item.content,
    item.notes,
    item.semanticKey,
    item.sourceRef,
    parseTags(item.tags).join(" "),
  ].join("\n");
}

function latestCycle(projectId: string) {
  return storage.listCycles(projectId).at(-1);
}

function openReviewExists(input: {
  projectId: string;
  reviewType: string;
  primaryKnowledgeId: string;
  relatedKnowledgeId?: string | null;
}): KnowledgeReviewItem | undefined {
  return storage.listKnowledgeReviews(input.projectId).find((review) => (
    review.status === "review_required" &&
    review.reviewType === input.reviewType &&
    review.primaryKnowledgeId === input.primaryKnowledgeId &&
    (review.relatedKnowledgeId ?? "") === (input.relatedKnowledgeId ?? "")
  ));
}

function reviewId(input: {
  projectId: string;
  reviewType: string;
  primaryKnowledgeId: string;
  relatedKnowledgeId?: string | null;
}): string {
  const key = makeIdempotencyKey({
    projectId: input.projectId,
    actionType: `knowledge_review.${input.reviewType}`,
    target: `${input.primaryKnowledgeId}:${input.relatedKnowledgeId ?? ""}`,
  });
  return `kr_${key.slice(-8)}`;
}

function nextReviewId(input: {
  projectId: string;
  reviewType: string;
  primaryKnowledgeId: string;
  relatedKnowledgeId?: string | null;
}): string {
  const baseId = reviewId(input);
  if (!storage.getKnowledgeReview(baseId)) return baseId;
  // Open reviews are reused before id allocation; a suffix means the prior review
  // was already resolved, so this detection needs an independently resolvable row.
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    const candidateId = `${baseId}__r${attempt}`;
    if (!storage.getKnowledgeReview(candidateId)) return candidateId;
  }
  throw new Error(`unable to allocate knowledge review id for ${baseId}`);
}

function ensureReview(input: {
  projectId: string;
  cycleId?: string | null;
  reviewType: string;
  primaryKnowledgeId: string;
  relatedKnowledgeId?: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  recommendedAction: string;
}): KnowledgeReviewItem {
  const existing = openReviewExists(input);
  if (existing) return existing;
  const createdAt = now();
  const review = storage.createKnowledgeReview({
    id: nextReviewId(input),
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    reviewType: input.reviewType,
    status: "review_required",
    primaryKnowledgeId: input.primaryKnowledgeId,
    relatedKnowledgeId: input.relatedKnowledgeId ?? null,
    reason: input.reason,
    evidence: JSON.stringify(input.evidence),
    recommendedAction: input.recommendedAction,
    createdAt,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    version: 1,
  });
  recordTrace({
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    cycleIdx: input.cycleId ? storage.getCycle(input.cycleId)?.idx ?? null : null,
    kind: "principle_transition",
    name: "knowledge_review_required",
    agent: "librarian",
    status: "blocked",
    attributes: {
      reviewId: review.id,
      reviewType: review.reviewType,
      primaryKnowledgeId: review.primaryKnowledgeId,
      relatedKnowledgeId: review.relatedKnowledgeId,
      reason: review.reason,
    },
  });
  return review;
}

function ensureReviewGate(review: KnowledgeReviewItem, blocking: boolean): void {
  if (!review.cycleId) return;
  const gateId = `gate_${review.id}`;
  if (storage.getGate(gateId)) return;
  storage.createGate({
    id: gateId,
    cycleId: review.cycleId,
    type: blocking ? "risk" : "meaning",
    blocking: blocking ? 1 : 0,
    title: blocking ? "知识冲突复核" : "知识复核提醒",
    payload: withDecisionBriefPayload({
      riskKey: review.reviewType === "conflict" ? "knowledge_conflict_review" : "knowledge_review_reminder",
      reviewId: review.id,
      reviewType: review.reviewType,
      primaryKnowledgeId: review.primaryKnowledgeId,
      relatedKnowledgeId: review.relatedKnowledgeId,
      reason: review.reason,
      recommendedAction: review.recommendedAction,
      createdAt: review.createdAt,
    }, createDecisionBrief({
      claim: `${review.reviewType} review for ${review.primaryKnowledgeId}`,
      citedKnowledgeIds: [review.primaryKnowledgeId, review.relatedKnowledgeId].filter((id): id is string => Boolean(id)),
      metric: "knowledge_review_resolution",
      timeWindow: "before reviewed knowledge is reused",
      ifApproved: "The selected knowledge review action will update knowledge status and close this gate.",
      ifRejected: "The review remains unresolved and the disputed knowledge should not gain new authority.",
      rollbackRef: `knowledge_review_items:${review.id}`,
    })),
    status: "pending",
    estimatedMinutes: blocking ? 12 : 6,
    decision: null,
    version: 1,
  });
}

type MetricClaim = { metric: string; operator: ">=" | "<="; threshold: number; raw: string };
type TopicPolarity = "prefer" | "avoid";
type TopicSignal = { topic: string; polarity: TopicPolarity; source: "metric" | "text"; raw: string };

const SIGNAL_TOPIC_PATTERNS = [
  { topic: "ppg", pattern: /\bppg\b|光电容积|photoplethysmography/i },
  { topic: "ecg", pattern: /\becg\b|心电|electrocardiogram/i },
  { topic: "hybrid", pattern: /\bhybrid\b|混合|融合|双模/i },
] as const;

const INTERNAL_DRAFT_CREATORS = new Set(["distiller", "builder", "librarian", "scheduler", "agent", "test"]);
const EXTERNAL_EVIDENCE_SOURCE_TYPES = new Set(["feedback", "form_feedback", "business_signal", "external_feedback"]);
const EXTERNAL_EVIDENCE_TAGS = new Set(["meaning_gate", "human_approved", "form_feedback", "business_signal", "health_signal"]);

function extractMetricClaims(item: KnowledgeItem): MetricClaim[] {
  const text = `${item.title}\n${item.content}\n${item.notes}`;
  const claims: MetricClaim[] = [];
  const regex = /([A-Za-z][A-Za-z0-9_ -]{1,60}|[\u3400-\u9fff][\u3400-\u9fffA-Za-z0-9_ -]{1,60})\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)/g;
  let match = regex.exec(text);
  while (match) {
    const op = match[2] === ">" ? ">=" : match[2] === "<" ? "<=" : match[2];
    claims.push({
      metric: normalizeKey(match[1]),
      operator: op as ">=" | "<=",
      threshold: Number(match[3]),
      raw: match[0],
    });
    match = regex.exec(text);
  }
  return claims;
}

function isSpeculativeOrInternalDraft(item: KnowledgeItem): boolean {
  const tags = parseTags(item.tags).map((tag) => tag.toLowerCase());
  const createdBy = item.createdBy.toLowerCase();
  return tags.includes("speculative") ||
    item.sourceRef.toLowerCase().includes("cycle_spec_") ||
    INTERNAL_DRAFT_CREATORS.has(createdBy);
}

function isExternalEvidenceDraft(item: KnowledgeItem): boolean {
  if (item.status !== "draft" || item.supersededBy || isOnboardingSeedKnowledge(item) || isSpeculativeOrInternalDraft(item)) return false;
  const tags = parseTags(item.tags).map((tag) => tag.toLowerCase());
  const sourceType = item.sourceType.toLowerCase();
  const createdBy = item.createdBy.toLowerCase();
  return createdBy === "human_gate" ||
    EXTERNAL_EVIDENCE_SOURCE_TYPES.has(sourceType) ||
    tags.some((tag) => EXTERNAL_EVIDENCE_TAGS.has(tag));
}

function isConflictScannableKnowledge(item: KnowledgeItem): boolean {
  if (item.supersededBy) return false;
  if (["active", "strong"].includes(item.status)) return true;
  return isExternalEvidenceDraft(item);
}

function topicFromMetric(metric: string): string | null {
  for (const candidate of SIGNAL_TOPIC_PATTERNS) {
    if (candidate.pattern.test(metric)) return candidate.topic;
  }
  return null;
}

function addSignal(signals: TopicSignal[], signal: TopicSignal): void {
  if (signals.some((item) => item.topic === signal.topic && item.polarity === signal.polarity && item.raw === signal.raw)) return;
  signals.push(signal);
}

function extractTopicSignals(item: KnowledgeItem): TopicSignal[] {
  const text = knowledgeText(item);
  const compact = text.replace(/\s+/g, " ");
  const signals: TopicSignal[] = [];

  for (const claim of extractMetricClaims(item)) {
    const topic = topicFromMetric(claim.metric);
    if (!topic) continue;
    if (/\bpriority\b|优先|score|得分|suitability|fit|置信/i.test(claim.metric)) {
      addSignal(signals, {
        topic,
        polarity: claim.operator === ">=" ? "prefer" : "avoid",
        source: "metric",
        raw: claim.raw,
      });
    }
  }

  for (const { topic, pattern } of SIGNAL_TOPIC_PATTERNS) {
    const directPrefer = new RegExp(`(?:优先|首选|推荐|偏向|prefer|prioriti[sz]e|preferred|priority)[^\\n。；;,.]{0,24}(?:${pattern.source})`, "i");
    const reversePrefer = new RegExp(`(?:${pattern.source})[^\\n。；;,.]{0,24}(?:优先|首选|推荐|更适合|prefer|prioriti[sz]e|preferred|priority)`, "i");
    const directAvoid = new RegExp(`(?:不应|不能|不适合|避免|规避|拒绝|avoid|reject|not)[^\\n。；;,.]{0,24}(?:${pattern.source})`, "i");
    const reverseAvoid = new RegExp(`(?:${pattern.source})[^\\n。；;,.]{0,24}(?:不应|不能|不适合|避免|规避|拒绝|avoid|reject|not)`, "i");
    if (directPrefer.test(compact) || reversePrefer.test(compact)) {
      addSignal(signals, { topic, polarity: "prefer", source: "text", raw: topic });
    }
    if (directAvoid.test(compact) || reverseAvoid.test(compact)) {
      addSignal(signals, { topic, polarity: "avoid", source: "text", raw: topic });
    }
  }

  return signals;
}

function sameDecisionTopic(a: KnowledgeItem, b: KnowledgeItem): boolean {
  const leftKey = knowledgeKey(a);
  const rightKey = knowledgeKey(b);
  if (leftKey && rightKey && leftKey === rightKey) return true;
  const leftTags = parseTags(a.tags).map((tag) => tag.toLowerCase());
  const rightTags = parseTags(b.tags).map((tag) => tag.toLowerCase());
  if (leftTags.includes("health_signal") && rightTags.includes("health_signal")) return true;
  const leftText = knowledgeText(a);
  const rightText = knowledgeText(b);
  return /health_signal|健康信号|wearable|穿戴/i.test(leftText) && /health_signal|健康信号|wearable|穿戴/i.test(rightText);
}

function topicPolarityConflict(a: KnowledgeItem, b: KnowledgeItem): Record<string, unknown> | null {
  if (isOnboardingSeedKnowledge(a) || isOnboardingSeedKnowledge(b)) return null;
  if (!sameDecisionTopic(a, b)) return null;
  const left = extractTopicSignals(a);
  const right = extractTopicSignals(b);
  for (const l of left) {
    for (const r of right) {
      if (l.topic === r.topic && l.polarity !== r.polarity) {
        return { reason: "same signal topic has opposite priority polarity", left: l, right: r };
      }
      if (l.polarity === "prefer" && r.polarity === "prefer" && l.topic !== r.topic) {
        return { reason: "same decision topic prefers mutually exclusive signal choices", left: l, right: r };
      }
    }
  }
  return null;
}

function conclusionTags(item: KnowledgeItem): string[] {
  const tags = parseTags(item.tags).map((tag) => tag.toLowerCase());
  const out: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith("conclusion:")) out.push(tag.slice("conclusion:".length));
    else if (/^(works|supports|approve|increase|positive|success|valid)$/.test(tag)) out.push("positive");
    else if (/^(fails|rejects|avoid|decrease|negative|failure|invalid)$/.test(tag)) out.push("negative");
  }
  return Array.from(new Set(out));
}

function incompatibleConclusions(a: KnowledgeItem, b: KnowledgeItem): boolean {
  const left = conclusionTags(a);
  const right = conclusionTags(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left.includes("positive") && right.includes("negative")) return true;
  if (left.includes("negative") && right.includes("positive")) return true;
  return left.some((tag) => right.some((other) => other !== tag && tag.split(":")[0] === other.split(":")[0]));
}

function explicitContradictionMarkers(a: KnowledgeItem, b: KnowledgeItem): string | null {
  const haystack = `${parseTags(a.tags).join(" ")}\n${a.notes}\n${a.sourceRef}\n${a.content}`;
  const reverse = `${parseTags(b.tags).join(" ")}\n${b.notes}\n${b.sourceRef}\n${b.content}`;
  const targeted = [
    new RegExp(`(?:contradicts|conflicts?[_ -]?with|contradiction[_ -]?with)[:= ]+${b.id}\\b`, "i"),
    new RegExp(`(?:contradicts|conflicts?[_ -]?with|contradiction[_ -]?with)[:= ]+${a.id}\\b`, "i"),
  ];
  if (targeted[0].test(haystack)) return "explicit contradiction marker on primary knowledge";
  if (targeted[1].test(reverse)) return "explicit contradiction marker on related knowledge";

  if (isOnboardingSeedKnowledge(a) || isOnboardingSeedKnowledge(b)) return null;

  const genericMarker = /contradicts_strong|conflict_with_strong|needs_conflict_review|明确冲突|互相矛盾/i;
  if (genericMarker.test(haystack)) return "explicit contradiction marker on primary knowledge";
  if (genericMarker.test(reverse)) return "explicit contradiction marker on related knowledge";
  return null;
}

function metricConflict(a: KnowledgeItem, b: KnowledgeItem): Record<string, unknown> | null {
  const left = extractMetricClaims(a);
  const right = extractMetricClaims(b);
  for (const l of left) {
    for (const r of right) {
      const sameMetric = l.metric === r.metric || knowledgeKey(a) === knowledgeKey(b);
      if (!sameMetric) continue;
      if (l.operator !== r.operator) {
        return { metric: l.metric, left: l, right: r, reason: "opposite metric operators" };
      }
    }
  }
  return null;
}

function conflictBetween(a: KnowledgeItem, b: KnowledgeItem): ConflictCandidate | null {
  const metric = metricConflict(a, b);
  if (metric) {
    return {
      primaryKnowledgeId: a.id,
      relatedKnowledgeId: b.id,
      reason: "same topic/title has opposite metric operator or incompatible threshold direction",
      evidence: metric,
      recommendedAction: "review metric threshold and approve one current knowledge item",
    };
  }
  if (knowledgeKey(a) && knowledgeKey(a) === knowledgeKey(b) && incompatibleConclusions(a, b)) {
    return {
      primaryKnowledgeId: a.id,
      relatedKnowledgeId: b.id,
      reason: "same normalized key has incompatible conclusion tags",
      evidence: { key: knowledgeKey(a), leftTags: parseTags(a.tags), rightTags: parseTags(b.tags) },
      recommendedAction: "review conclusion tags and quarantine, stale, or supersede the weaker item",
    };
  }
  const topicPolarity = topicPolarityConflict(a, b);
  if (topicPolarity) {
    return {
      primaryKnowledgeId: a.id,
      relatedKnowledgeId: b.id,
      reason: "topic-level conclusion or metric polarity conflicts with related evidence",
      evidence: topicPolarity,
      recommendedAction: "review topic-level priority evidence and approve one current knowledge item",
    };
  }
  const marker = explicitContradictionMarkers(a, b);
  if (marker) {
    return {
      primaryKnowledgeId: a.id,
      relatedKnowledgeId: b.id,
      reason: marker,
      evidence: { leftTags: parseTags(a.tags), rightTags: parseTags(b.tags), leftNotes: a.notes, rightNotes: b.notes },
      recommendedAction: "review explicit contradiction marker before reuse",
    };
  }
  return null;
}

function weakerFirst(a: KnowledgeItem, b: KnowledgeItem): [KnowledgeItem, KnowledgeItem] {
  if (a.status === "strong" && b.status !== "strong") return [b, a];
  if (b.status === "strong" && a.status !== "strong") return [a, b];
  if (a.confidenceScore !== b.confidenceScore) return a.confidenceScore < b.confidenceScore ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

function parseReviewResolution(review: KnowledgeReviewItem): Partial<ResolveKnowledgeReviewInput> {
  if (!review.resolution) return {};
  try {
    const parsed = JSON.parse(review.resolution) as Partial<ResolveKnowledgeReviewInput>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clusterKnowledgeIds(review: KnowledgeReviewItem): string[] {
  const resolution = parseReviewResolution(review);
  return Array.from(new Set([
    review.primaryKnowledgeId,
    review.relatedKnowledgeId ?? "",
    resolution.survivorKnowledgeId ?? "",
  ].filter((id): id is string => typeof id === "string" && id.length > 0)));
}

export function resolvedConflictActiveSurvivorViolations(projectId: string): ResolvedConflictSurvivorViolation[] {
  const violations: ResolvedConflictSurvivorViolation[] = [];
  for (const review of storage.listKnowledgeReviews(projectId)) {
    if (review.reviewType !== "conflict" || review.status !== "resolved") continue;
    const ids = clusterKnowledgeIds(review);
    const items = ids
      .map((id) => storage.getKnowledge(id))
      .filter((item): item is KnowledgeItem => !!item && item.projectId === projectId);
    if (items.length === 0) continue;
    const explicitlyQuarantinedCluster = items.every((item) => item.status === "quarantined");
    if (explicitlyQuarantinedCluster) continue;
    const hasActiveSurvivor = items.some((item) => !item.supersededBy && (item.status === "active" || item.status === "strong"));
    if (!hasActiveSurvivor) {
      violations.push({
        reviewId: review.id,
        projectId,
        knowledgeIds: ids,
        reason: "resolved conflict cluster has no active/strong non-superseded survivor",
      });
    }
  }
  return violations;
}

export function assertResolvedConflictActiveSurvivors(projectId: string): void {
  const violations = resolvedConflictActiveSurvivorViolations(projectId);
  if (violations.length === 0) return;
  throw new Error(`resolved conflict survivor invariant failed: ${violations.map((item) => `${item.reviewId}:${item.knowledgeIds.join("|")}`).join(", ")}`);
}

export function detectKnowledgeConflicts(projectId: string): ConflictCandidate[] {
  const active = storage.listKnowledge(projectId).filter(isConflictScannableKnowledge);
  const cycle = latestCycle(projectId);
  const candidates: ConflictCandidate[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const [primary, related] = weakerFirst(active[i], active[j]);
      const conflict = conflictBetween(primary, related);
      if (!conflict) continue;
      candidates.push(conflict);
      if (primary.status !== "conflict") {
        storage.updateKnowledge(primary.id, {
          status: "conflict",
          notes: `${primary.notes}\nConflict candidate with ${related.id}: ${conflict.reason}`.trim(),
          actor: "librarian",
        });
      }
      const review = ensureReview({
        projectId,
        cycleId: cycle?.id ?? null,
        reviewType: "conflict",
        primaryKnowledgeId: primary.id,
        relatedKnowledgeId: related.id,
        reason: conflict.reason,
        evidence: conflict.evidence,
        recommendedAction: conflict.recommendedAction,
      });
      ensureReviewGate(review, true);
    }
  }
  return candidates;
}

setKnowledgeConflictDetector((projectId) => {
  detectKnowledgeConflicts(projectId);
});

function lastVerifiedMs(item: KnowledgeItem): number {
  if (typeof item.lastVerifiedAt === "number" && Number.isFinite(item.lastVerifiedAt)) return item.lastVerifiedAt;
  const validFrom = Date.parse(item.validFrom);
  return Number.isFinite(validFrom) ? validFrom : 0;
}

export function createKnowledgeReviewReminders(projectId: string, options: KnowledgeReminderOptions = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterDays = options.staleAfterDays ?? 90;
  const expiryWithinDays = options.expiryWithinDays ?? 14;
  const cycle = latestCycle(projectId);
  const reminders: KnowledgeReviewItem[] = [];
  for (const item of storage.listKnowledge(projectId)) {
    if (item.supersededBy || !["active", "strong"].includes(item.status)) continue;
    const verifiedAgeDays = lastVerifiedMs(item) > 0 ? (nowMs - lastVerifiedMs(item)) / 86_400_000 : Number.POSITIVE_INFINITY;
    const validUntilMs = Date.parse(item.validUntil ?? "");
    const daysUntilExpiry = Number.isFinite(validUntilMs) ? (validUntilMs - nowMs) / 86_400_000 : Number.POSITIVE_INFINITY;
    const reviewType = verifiedAgeDays >= staleAfterDays ? "stale_review" : daysUntilExpiry <= expiryWithinDays ? "expiry_review" : "";
    if (!reviewType) continue;
    const review = ensureReview({
      projectId,
      cycleId: cycle?.id ?? null,
      reviewType,
      primaryKnowledgeId: item.id,
      reason: reviewType === "stale_review"
        ? `knowledge has not been verified for ${Math.floor(verifiedAgeDays)} days`
        : `knowledge expires in ${Math.ceil(daysUntilExpiry)} days`,
      evidence: {
        knowledgeId: item.id,
        lastVerifiedAt: item.lastVerifiedAt,
        validUntil: item.validUntil,
        verifiedAgeDays: Number.isFinite(verifiedAgeDays) ? +verifiedAgeDays.toFixed(2) : null,
        daysUntilExpiry: Number.isFinite(daysUntilExpiry) ? +daysUntilExpiry.toFixed(2) : null,
      },
      recommendedAction: reviewType === "stale_review" ? "approve_as_current or downgrade_to_stale" : "approve_as_current or downgrade_to_stale",
    });
    ensureReviewGate(review, false);
    reminders.push(review);
  }
  return reminders;
}

export function resolveKnowledgeReview(reviewId: string, input: ResolveKnowledgeReviewInput): KnowledgeReviewItem {
  const review = storage.getKnowledgeReview(reviewId);
  if (!review) throw new Error(`knowledge review not found: ${reviewId}`);
  if (review.status !== "review_required") {
    throw new Error(`knowledge review already resolved: ${reviewId}`);
  }
  const primary = storage.getKnowledge(review.primaryKnowledgeId);
  if (!primary) throw new Error(`knowledge not found: ${review.primaryKnowledgeId}`);
  const actor = input.actor ?? "human";
  const timestamp = now();
  const cycle = review.cycleId ? storage.getCycle(review.cycleId) : latestCycle(review.projectId);
  const resolution = {
    action: input.action,
    rationale: input.rationale ?? "",
    survivorKnowledgeId: input.survivorKnowledgeId ?? null,
    resolvedAt: timestamp,
  };

	  const applyResolution = () => {
	    if (input.action === "approve_as_current" || input.action === "reject_conflict") {
	      const approvedStatus = primary.status === "strong" ? "strong" : "active";
	      storage.updateKnowledge(primary.id, {
	        status: approvedStatus,
	        supersededBy: null,
	        lastVerifiedAt: Date.now(),
        lastValidatedCycle: cycle?.idx ?? primary.lastValidatedCycle,
        notes: `${primary.notes}\nReview ${review.id}: ${input.action}. ${input.rationale ?? ""}`.trim(),
        actor,
      });
    } else if (input.action === "quarantine") {
      storage.updateKnowledge(primary.id, { status: "quarantined", notes: `${primary.notes}\nReview ${review.id}: quarantined.`.trim(), actor });
    } else if (input.action === "downgrade_to_stale") {
      storage.updateKnowledge(primary.id, { status: "stale", notes: `${primary.notes}\nReview ${review.id}: downgraded to stale.`.trim(), actor });
    } else if (input.action === "merge_supersede") {
      const survivor = input.survivorKnowledgeId || review.relatedKnowledgeId;
      if (!survivor) throw new Error("merge_supersede requires survivorKnowledgeId or relatedKnowledgeId");
      const survivorKnowledge = storage.getKnowledge(survivor);
      if (!survivorKnowledge || survivorKnowledge.projectId !== review.projectId) {
        throw new Error(`survivor knowledge not found: ${survivor}`);
      }
      const survivorStatus = survivorKnowledge.status === "strong" ? "strong" : "active";
      storage.updateKnowledge(primary.id, {
        status: "deprecated",
        supersededBy: survivor,
        notes: `${primary.notes}\nReview ${review.id}: superseded by ${survivor}.`.trim(),
        actor,
      });
      storage.updateKnowledge(survivorKnowledge.id, {
        status: survivorStatus,
        supersededBy: null,
        lastVerifiedAt: Date.now(),
        lastValidatedCycle: cycle?.idx ?? survivorKnowledge.lastValidatedCycle,
        notes: `${survivorKnowledge.notes}\nReview ${review.id}: survivor retained as active knowledge after absorbing contradiction from ${primary.id}. ${input.rationale ?? ""}`.trim(),
        actor,
      });
    }
    storage.updateKnowledgeReview(review.id, {
      status: "resolved",
      resolvedAt: timestamp,
      resolvedBy: actor,
      resolution: JSON.stringify(resolution),
    });
    const gate = storage.getGate(`gate_${review.id}`);
    if (gate?.status === "pending") {
      const decision = `knowledge_review:${input.action}`;
      new HumanGateService(storage).systemResolve(gate.id, decision, {
        actor,
        status: "approved",
        via: "knowledge_review",
        reason: input.rationale ?? "",
      });
    }
  };
  if (storage.withTransaction) storage.withTransaction(applyResolution);
  else applyResolution();
  if (review.reviewType === "conflict" && input.action === "merge_supersede") {
    const currentViolation = resolvedConflictActiveSurvivorViolations(review.projectId).find((item) => item.reviewId === review.id);
    if (currentViolation) {
      throw new Error(`resolved conflict survivor invariant failed: ${currentViolation.reviewId}:${currentViolation.knowledgeIds.join("|")}`);
    }
  }

  const resolved = storage.getKnowledgeReview(review.id);
  if (!resolved) throw new Error(`knowledge review disappeared: ${review.id}`);
  recordActionProposal({
    projectId: review.projectId,
    cycleId: review.cycleId ?? cycle?.id ?? null,
    actionType: `knowledge_review.${input.action}`,
    target: review.primaryKnowledgeId,
    explicitRiskLevel: input.action === "quarantine" || input.action === "merge_supersede" ? "local_write" : "draft_only",
    payload: {
      reviewId: review.id,
      action: input.action,
      relatedKnowledgeId: review.relatedKnowledgeId,
      rationale: input.rationale ?? "",
    },
    rollbackPlan: {
      restoreKnowledgeStatus: primary.status,
      restoreSupersededBy: primary.supersededBy ?? null,
    },
    auditSummary: {
      reviewId: review.id,
      reviewType: review.reviewType,
      action: input.action,
    },
  });
  recordTrace({
    projectId: review.projectId,
    cycleId: review.cycleId ?? cycle?.id ?? null,
    cycleIdx: cycle?.idx ?? null,
    kind: "approval",
    name: "knowledge_review_resolved",
    agent: actor,
    attributes: {
      reviewId: review.id,
      action: input.action,
      primaryKnowledgeId: review.primaryKnowledgeId,
      relatedKnowledgeId: review.relatedKnowledgeId,
    },
  });
  return resolved;
}
