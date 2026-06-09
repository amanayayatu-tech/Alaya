import type { HumanGateItem } from "@shared/schema";
import { HumanGateService } from "../humanGateService";
import { resolveKnowledgeReview } from "../knowledgeReview";
import type { IStorage } from "../storage";
import { now, storage } from "../storage";
import { redactSensitiveText } from "../security/redact";
import { escapeMarkdownV2 } from "./telegram-simple";
import { compactGateCallbackTarget, compactReviewCallbackTarget, gateCard, statusCard } from "./card";
import {
  formatGateDecisionReceiptText,
  formatGateDecisionRequestText,
  formatGateProcessingText,
  knowledgeIdForMeaningGate,
} from "./gateNarrative";
import type { MessageRef, MessagingPlatform } from "./types";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function gateUrl(baseUrl: string, gateId?: string, projectId?: string): string {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (gateId) params.set("gate", gateId);
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return `${trimTrailingSlash(baseUrl)}/#/human-gates${suffix}`;
}

function resolveGateCallbackTarget(store: IStorage, target: string): string {
  if (!target.startsWith("t:")) return target;
  const gate = store.listGates().find((item) =>
    compactGateCallbackTarget(item.id, "perm:allow:") === target ||
    compactGateCallbackTarget(item.id, "perm:deny:") === target ||
    compactGateCallbackTarget(item.id, "nav:gate:") === target
  );
  return gate?.id ?? target;
}

function resolveReviewCallbackTarget(store: IStorage, target: string): string {
  if (!target.startsWith("t:")) return target;
  const review = store.listKnowledgeReviews().find((item) =>
    compactReviewCallbackTarget(item.id, "kr:q:") === target ||
    compactReviewCallbackTarget(item.id, "kr:m:") === target
  );
  return review?.id ?? target;
}

function parseGatePayload(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface CallbackFailureContext {
  projectId: string;
  cycleId?: string | null;
  cycleIdx?: number | null;
  gateId?: string | null;
  reviewId?: string | null;
  chatId?: string;
  messageId?: number;
}

export class CallbackRouter {
  constructor(
    private platform: MessagingPlatform,
    private store: IStorage = storage,
    private gateService = new HumanGateService(store),
    private baseUrl = process.env.ALAYA_BASE_URL ?? "http://localhost:5000",
  ) {}

  async route(callbackId: string, data: string, ref: MessageRef): Promise<void> {
    const callbackContext = this.callbackFailureContextForData(data, ref);
    const callbackWarning = callbackId
      ? await this.bestEffortTelegramFeedback("answerCallback", () => this.platform.answerCallback(callbackId), callbackContext)
      : null;

    if (data.startsWith("perm:allow:")) {
      await this.handlePerm(resolveGateCallbackTarget(this.store, data.replace("perm:allow:", "")), "approve", ref, callbackWarning);
    } else if (data.startsWith("perm:deny:")) {
      await this.handlePerm(resolveGateCallbackTarget(this.store, data.replace("perm:deny:", "")), "reject", ref, callbackWarning);
    } else if (data.startsWith("kr:q:")) {
      await this.handleKnowledgeReview(resolveReviewCallbackTarget(this.store, data.replace("kr:q:", "")), "quarantine", ref, callbackWarning);
    } else if (data.startsWith("kr:m:")) {
      await this.handleKnowledgeReview(resolveReviewCallbackTarget(this.store, data.replace("kr:m:", "")), "merge_supersede", ref, callbackWarning);
    } else if (data.startsWith("nav:gate:")) {
      await this.handleNavGate(resolveGateCallbackTarget(this.store, data.replace("nav:gate:", "")), ref.chatId);
    } else if (data.startsWith("cmd:/status")) {
      await this.handleStatusCmd(ref.chatId);
    } else if (data.startsWith("cmd:/gates")) {
      await this.handleGatesCmd(ref.chatId);
    }
  }

  private async handlePerm(gateId: string, action: "approve" | "reject", ref: MessageRef, callbackWarning?: string | null): Promise<void> {
    const gate = this.store.getGate(gateId);
    if (!gate) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到闸门：${gateId}`) });
      return;
    }
    const payload = parseGatePayload(gate.payload);
    if (gate.status !== "pending") {
      const projectId = this.store.getCycle(gate.cycleId)?.projectId ?? "system";
      const pendingGatesAfter = this.store.listGates(projectId).filter((item) => item.status === "pending").length;
      const openConflictReviewsAfter = this.store
        .listKnowledgeReviews(projectId)
        .filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
      await this.bestEffortTelegramFeedback("editCard(stale receipt)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(formatGateDecisionReceiptText(gate, {
            action: gate.status === "rejected" ? "reject" : "approve",
            dryRun: false,
            via: "Telegram",
            decidedAt: new Date(),
            pendingGatesAfter,
            openConflictReviewsAfter,
            knowledgeId: gate.status === "approved" && gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null,
            projectId,
            rationale: "该 Telegram 卡片已过期；系统按当前闸门状态回填结果，未重复执行决策。",
            callbackWarning: callbackWarning ?? undefined,
          })),
        }));
      return;
    }
    if (gate.type === "risk" && payload.riskKey === "knowledge_conflict_review") {
      const projectId = this.store.getCycle(gate.cycleId)?.projectId;
      await this.platform.sendText(ref.chatId, escapeMarkdownV2(`这是知识冲突复核，请使用“隔离当前”或“保留既有”按钮处理：${gateUrl(this.baseUrl, gate.id, projectId)}`));
      return;
    }

    const failureContext = this.callbackFailureContextForGate(gate, ref);
    await this.bestEffortTelegramFeedback("sendTyping", () => this.platform.sendTyping?.(ref.chatId), failureContext);
    await this.bestEffortTelegramFeedback("editCard(processing)", () =>
      this.platform.editCard(ref, { body: escapeMarkdownV2(formatGateProcessingText(gate)) }), failureContext);

    try {
      const result = action === "approve"
        ? this.gateService.approve(gate.id, { via: "telegram", actor: "human_telegram" })
        : this.gateService.reject(gate.id, { via: "telegram", actor: "human_telegram" });
      const projectId = this.store.getCycle(gate.cycleId)?.projectId ?? "system";
      const pendingGatesAfter = this.store.listGates(projectId).filter((item) => item.status === "pending").length;
      const openConflictReviewsAfter = this.store
        .listKnowledgeReviews(projectId)
        .filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
      await this.bestEffortTelegramFeedback("editCard(receipt)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(formatGateDecisionReceiptText(result.gate ?? gate, {
            action,
            dryRun: result.dryRun,
            via: "Telegram",
            decidedAt: new Date(),
            pendingGatesAfter,
            openConflictReviewsAfter,
            knowledgeId: action === "approve" && gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null,
            projectId,
            callbackWarning: callbackWarning ?? undefined,
          })),
        }), failureContext);
    } catch (error) {
      await this.bestEffortTelegramFeedback("editCard(error)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(`处理失败：${error instanceof Error ? error.message : String(error)}`),
        }), failureContext);
    }
  }

  private async handleKnowledgeReview(reviewId: string, action: "quarantine" | "merge_supersede", ref: MessageRef, callbackWarning?: string | null): Promise<void> {
    const review = this.store.getKnowledgeReview(reviewId);
    if (!review) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到知识复核：${reviewId}`) });
      return;
    }
    const gate = this.store.getGate(`gate_${reviewId}`);
    const projectId = review.projectId;
    const receiptGate = gate ?? {
      id: `gate_${reviewId}`,
      title: "知识冲突复核",
      type: "risk",
      blocking: 1,
      cycleId: review.cycleId,
      estimatedMinutes: 12,
      payload: JSON.stringify({ reason: review.reason, reviewId }),
    };

    if (review.status !== "review_required") {
      const pendingGatesAfter = this.store.listGates(projectId).filter((item) => item.status === "pending").length;
      const openConflictReviewsAfter = this.store
        .listKnowledgeReviews(projectId)
        .filter((item) => item.reviewType === "conflict" && item.status === "review_required").length;
      await this.bestEffortTelegramFeedback("editCard(stale knowledge review receipt)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(formatGateDecisionReceiptText(receiptGate, {
            action: "approve",
            dryRun: false,
            via: "Telegram",
            decidedAt: new Date(),
            pendingGatesAfter,
            openConflictReviewsAfter,
            projectId,
            rationale: "该知识复核已处理；Telegram 回填当前状态，未重复执行决策。",
            callbackWarning: callbackWarning ?? undefined,
          })),
        }));
      return;
    }

    const failureContext = this.callbackFailureContextForKnowledgeReview(reviewId, ref);
    await this.bestEffortTelegramFeedback("sendTyping", () => this.platform.sendTyping?.(ref.chatId), failureContext);
    await this.bestEffortTelegramFeedback("editCard(processing knowledge review)", () =>
      this.platform.editCard(ref, { body: escapeMarkdownV2(formatGateProcessingText(receiptGate)) }), failureContext);

    try {
      const rationale = action === "quarantine"
        ? "Telegram 冲突复核：隔离当前 primary 知识，保留冲突证据但不让它进入 active 复用路径。"
        : "Telegram 冲突复核：将当前 primary 知识标记为被既有 related 知识 supersede，保留既有结论作为 survivor。";
      resolveKnowledgeReview(reviewId, {
        action,
        rationale,
        actor: "human_telegram",
        survivorKnowledgeId: action === "merge_supersede" ? review.relatedKnowledgeId ?? undefined : undefined,
      });
      const resolvedGate = this.store.getGate(`gate_${reviewId}`) ?? receiptGate;
      const pendingGatesAfter = this.store.listGates(projectId).filter((item) => item.status === "pending").length;
      const openConflictReviewsAfter = this.store
        .listKnowledgeReviews(projectId)
        .filter((item) => item.reviewType === "conflict" && item.status === "review_required").length;
      await this.bestEffortTelegramFeedback("editCard(knowledge review receipt)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(formatGateDecisionReceiptText(resolvedGate, {
            action: "approve",
            dryRun: false,
            via: "Telegram",
            decidedAt: new Date(),
            pendingGatesAfter,
            openConflictReviewsAfter,
            projectId,
            rationale: `知识冲突复核已处理：${action}。${rationale}`,
            callbackWarning: callbackWarning ?? undefined,
          })),
        }), failureContext);
    } catch (error) {
      await this.bestEffortTelegramFeedback("editCard(knowledge review error)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(`处理失败：${error instanceof Error ? error.message : String(error)}`),
        }), failureContext);
    }
  }

  private async bestEffortTelegramFeedback(
    operation: string,
    task: () => Promise<void> | void,
    context?: CallbackFailureContext,
  ): Promise<string | null> {
    try {
      await task();
      return null;
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      console.warn(`[CallbackRouter] Telegram ${operation} failed; continuing gate decision: ${message}`);
      this.recordTelegramFeedbackFailure(operation, message, context);
      return `Telegram ${operation} failed after the backend decision path continued: ${message}`;
    }
  }

  private callbackFailureContextForData(data: string, ref: MessageRef): CallbackFailureContext | undefined {
    if (data.startsWith("perm:allow:") || data.startsWith("perm:deny:") || data.startsWith("nav:gate:")) {
      const target = data.replace(/^(perm:allow:|perm:deny:|nav:gate:)/, "");
      const gate = this.store.getGate(resolveGateCallbackTarget(this.store, target));
      return gate ? this.callbackFailureContextForGate(gate, ref) : { projectId: "system", chatId: ref.chatId, messageId: ref.messageId };
    }
    if (data.startsWith("kr:q:") || data.startsWith("kr:m:")) {
      return this.callbackFailureContextForKnowledgeReview(data.replace(/^kr:[qm]:/, ""), ref);
    }
    return { projectId: "system", chatId: ref.chatId, messageId: ref.messageId };
  }

  private callbackFailureContextForGate(gate: HumanGateItem, ref: MessageRef): CallbackFailureContext {
    const cycle = this.store.getCycle(gate.cycleId);
    return {
      projectId: cycle?.projectId ?? "system",
      cycleId: gate.cycleId,
      cycleIdx: cycle?.idx ?? null,
      gateId: gate.id,
      chatId: ref.chatId,
      messageId: ref.messageId,
    };
  }

  private callbackFailureContextForKnowledgeReview(reviewId: string, ref: MessageRef): CallbackFailureContext {
    const review = this.store.getKnowledgeReview(reviewId);
    const cycle = review?.cycleId ? this.store.getCycle(review.cycleId) : undefined;
    return {
      projectId: review?.projectId ?? cycle?.projectId ?? "system",
      cycleId: review?.cycleId ?? null,
      cycleIdx: cycle?.idx ?? null,
      gateId: `gate_${reviewId}`,
      reviewId,
      chatId: ref.chatId,
      messageId: ref.messageId,
    };
  }

  private recordTelegramFeedbackFailure(operation: string, message: string, context?: CallbackFailureContext): void {
    const payload = {
      projectId: context?.projectId ?? "system",
      cycleId: context?.cycleId ?? null,
      gateId: context?.gateId ?? null,
      reviewId: context?.reviewId ?? null,
      operation,
      error: message,
      hasMessageRef: Boolean(context?.chatId && context?.messageId),
      ts: now(),
    };
    this.store.recordEvent({
      cycleIdx: context?.cycleIdx ?? 0,
      actor: "telegram_callback_router",
      tableName: "notifications",
      op: "callback_feedback_failed",
      before: null,
      after: JSON.stringify(payload),
      ts: payload.ts,
    });
  }

  private async handleNavGate(gateId: string, chatId: string): Promise<void> {
    const gate = this.store.getGate(gateId);
    const projectId = gate ? this.store.getCycle(gate.cycleId)?.projectId : undefined;
    await this.platform.sendText(chatId, escapeMarkdownV2(`请在 Web UI 处理该闸门：${gateUrl(this.baseUrl, gateId, projectId)}`));
  }

  private async handleStatusCmd(chatId: string): Promise<void> {
    const projects = this.store.getProjects();
    if (projects.length === 0) {
      await this.platform.sendText(chatId, escapeMarkdownV2("当前没有项目。"));
      return;
    }
    for (const project of projects) {
      const state = this.store.getProjectState(project.id);
      const pendingGates = this.store.getPendingGates(project.id);
      const knowledgeCount = this.store.getKnowledgeCount(project.id);
      await this.platform.sendCard(chatId, statusCard({
        projectId: project.id,
        cycle: state.currentCycle,
        pendingGates: pendingGates.length,
        knowledgeCount,
        lastCycleAt: state.lastCycleAt ?? "—",
      }));
    }
  }

  private async handleGatesCmd(chatId: string): Promise<void> {
    const projects = this.store.getProjects();
    for (const project of projects) {
      const gates = this.store.getPendingGates(project.id);
      if (gates.length === 0) {
        await this.platform.sendText(chatId, `✅ 项目 *${escapeMarkdownV2(project.id)}* 当前无待处理闸门`);
        continue;
      }
      for (const gate of gates) {
        const payload = parseGatePayload(gate.payload);
        await this.platform.sendCard(chatId, gateCard({
          title: gate.title,
          body: formatGateDecisionRequestText(gate, { projectId: project.id }),
          gateId: gate.id,
          gateType: gate.type,
          isBlocking: gate.blocking === 1,
          actionUrl: gateUrl(this.baseUrl, gate.id, project.id),
          riskKey: payload.riskKey,
          reviewId: payload.reviewId,
        }));
      }
    }
  }
}
