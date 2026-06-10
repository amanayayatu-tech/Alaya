import type { HumanGateItem } from "@shared/schema";
import { HumanGateService, type RejectReasonCode } from "../humanGateService";
import { resolveKnowledgeReview } from "../knowledgeReview";
import type { IStorage } from "../storage";
import { now, storage } from "../storage";
import { redactSensitiveText } from "../security/redact";
import { escapeMarkdownV2 } from "./telegram-simple";
import { applyGraceSecondsFromEnv } from "../config/env";
import { nextReviewWindowStartIso, reviewWindowState } from "../reviewWindow";
import { recordTrace } from "../trace";
import { compactGateCallbackTarget, compactProjectCallbackTarget, compactReviewCallbackTarget, gateCard, gateRejectReasonCard, plainTextCard, speculativeQueuedReceiptCard, statusCard } from "./card";
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
  const prefixes = [
    "perm:allow:",
    "perm:deny:",
    "perm:reject:",
    "perm:defer:",
    "perm:revoke:",
    "nav:gate:",
    "perm:reason:wrong_direction:",
    "perm:reason:weak_evidence:",
    "perm:reason:not_now:",
    "perm:reason:too_risky:",
    "perm:reason:risk_too_high:",
  ];
  const gate = store.listGates().find((item) =>
    prefixes.some((prefix) => compactGateCallbackTarget(item.id, prefix) === target)
  );
  return gate?.id ?? target;
}

function normalizeReasonCode(value: string): RejectReasonCode | null {
  if (value === "risk_too_high") return "too_risky";
  if (value === "wrong_direction" || value === "weak_evidence" || value === "not_now" || value === "too_risky") return value;
  return null;
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

function resolveProjectCallbackTarget(store: IStorage, target: string): string | undefined {
  if (!target) return undefined;
  if (!target.startsWith("t:")) return target;
  const project = store.getProjects().find((item) =>
    compactProjectCallbackTarget(item.id, "cmd:/review:") === target
  );
  return project?.id;
}

function reviewCommandProjectId(store: IStorage, data: string): string | undefined {
  const match = /^cmd:\/review(?::(.+))?$/.exec(data);
  return resolveProjectCallbackTarget(store, match?.[1] ?? "");
}

function reviewPausedFromEnv(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.ALAYA_REVIEW_PAUSED?.trim() ?? "");
}

function reviewPaused(store: IStorage): boolean {
  return store.getReviewPauseState() ?? reviewPausedFromEnv();
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
    if ((callbackId || data.startsWith("cmd:/")) && !(await this.authorizeTelegramInteraction(callbackId, data, ref, callbackContext))) return;
    const callbackWarning = callbackId
      ? await this.bestEffortTelegramFeedback("answerCallback", () => this.platform.answerCallback(callbackId), callbackContext)
      : null;

    if (data.startsWith("perm:allow:")) {
      await this.handlePerm(resolveGateCallbackTarget(this.store, data.replace("perm:allow:", "")), "approve", ref, callbackWarning);
    } else if (data.startsWith("perm:deny:")) {
      await this.handlePerm(resolveGateCallbackTarget(this.store, data.replace("perm:deny:", "")), "reject", ref, callbackWarning, "weak_evidence");
    } else if (data.startsWith("perm:reject:")) {
      await this.handleRejectMenu(resolveGateCallbackTarget(this.store, data.replace("perm:reject:", "")), ref);
    } else if (data.startsWith("perm:reason:")) {
      const match = /^perm:reason:([^:]+):(.+)$/.exec(data);
      const reasonCode = normalizeReasonCode(match?.[1] ?? "");
      if (!match || !reasonCode) {
        await this.platform.editCard(ref, { body: escapeMarkdownV2("无效的否决原因。") });
        return;
      }
      await this.handlePerm(resolveGateCallbackTarget(this.store, match[2]), "reject", ref, callbackWarning, reasonCode);
    } else if (data.startsWith("perm:defer:")) {
      await this.handleDefer(resolveGateCallbackTarget(this.store, data.replace("perm:defer:", "")), ref, callbackWarning);
    } else if (data.startsWith("perm:revoke:")) {
      await this.handleRevoke(resolveGateCallbackTarget(this.store, data.replace("perm:revoke:", "")), ref, callbackWarning);
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
    } else if (data.startsWith("cmd:/review")) {
      await this.handleReviewCmd(ref.chatId, reviewCommandProjectId(this.store, data));
    } else if (data.startsWith("cmd:/window")) {
      await this.handleWindowCmd(ref.chatId);
    } else if (data.startsWith("cmd:/pause")) {
      await this.handlePauseCmd(ref.chatId);
    } else if (data.startsWith("cmd:/resume")) {
      await this.handleResumeCmd(ref.chatId);
    }
  }

  private async authorizeTelegramInteraction(
    callbackId: string,
    data: string,
    ref: MessageRef,
    context?: CallbackFailureContext,
  ): Promise<boolean> {
    const requiredUserId = process.env.ALAYA_TELEGRAM_USER_ID?.trim();
    if (!requiredUserId) return true;
    if (ref.userId === requiredUserId) return true;
    if (callbackId) {
      await this.bestEffortTelegramFeedback("answerCallback(unauthorized)", () =>
        this.platform.answerCallback(callbackId, "未授权：此按钮仅绑定的 Telegram 用户可操作。"), context);
    } else {
      await this.bestEffortTelegramFeedback("sendText(unauthorized command)", () =>
        this.platform.sendText(ref.chatId, escapeMarkdownV2("未授权：此命令仅绑定的 Telegram 用户可操作。")), context);
    }
    const payload = {
      expectedUserId: requiredUserId,
      actualUserId: ref.userId ?? null,
      chatId: ref.chatId,
      messageId: ref.messageId,
      data,
      ts: now(),
    };
    const op = callbackId ? "telegram_unauthorized_callback" : "telegram_unauthorized_command";
    this.store.recordEvent({
      cycleIdx: context?.cycleIdx ?? 0,
      actor: "telegram_callback_router",
      tableName: "notifications",
      op,
      before: null,
      after: JSON.stringify(payload),
      ts: payload.ts,
    });
    recordTrace({
      projectId: context?.projectId ?? "system",
      cycleId: context?.cycleId ?? null,
      cycleIdx: context?.cycleIdx ?? null,
      kind: "notification",
      name: op,
      agent: "telegram_callback_router",
      status: "blocked",
      attributes: payload,
    });
    return false;
  }

  private async handlePerm(
    gateId: string,
    action: "approve" | "reject",
    ref: MessageRef,
    callbackWarning?: string | null,
    reasonCode?: RejectReasonCode,
  ): Promise<void> {
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
      const currentPayload = parseGatePayload(gate.payload);
      const result = action === "approve"
        ? this.gateService.approve(gate.id, {
          via: "telegram",
          actor: "human_telegram",
          reviewOpenedAt: currentPayload.telegramReviewOpenedAt,
        })
        : this.gateService.reject(gate.id, {
          via: "telegram",
          actor: "human_telegram",
          reasonCode,
          reviewOpenedAt: currentPayload.telegramReviewOpenedAt,
        });
      const projectId = this.store.getCycle(gate.cycleId)?.projectId ?? "system";
      const pendingGatesAfter = this.store.listGates(projectId).filter((item) => item.status === "pending").length;
      const openConflictReviewsAfter = this.store
        .listKnowledgeReviews(projectId)
        .filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
      const resolvedPayload = parseGatePayload(result.gate.payload);
      if (action === "approve" && gate.blocking === 1 && resolvedPayload.riskKey === "speculative_apply_draft") {
        const grace = applyGraceSecondsFromEnv();
        await this.bestEffortTelegramFeedback("editCard(speculative apply queued)", () =>
          this.platform.editCard(ref, speculativeQueuedReceiptCard({
            title: "已批准，进入 apply 队列",
            body: [
              `闸门「${gate.title}」已批准。`,
              `草稿已进入 apply 队列，${grace}s 内可撤销。`,
              `当前待处理闸门：${pendingGatesAfter} 个；开放知识冲突复核：${openConflictReviewsAfter} 个。`,
              callbackWarning ? `注意：${callbackWarning}` : "",
            ].filter(Boolean).join("\n"),
            gateId: gate.id,
          })), failureContext);
        return;
      }
      if (await this.maybeContinueReviewSession(projectId, ref, callbackWarning)) return;
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
            rationale: action === "reject" && reasonCode ? `reason_code=${reasonCode}` : undefined,
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

  private reviewSessionGates(projectId: string, sessionId: string): HumanGateItem[] {
    return this.store.listGates(projectId).filter((gate) => parseGatePayload(gate.payload).reviewSessionId === sessionId);
  }

  private pendingGatesForReviewSession(projectId: string, sessionId: string): HumanGateItem[] {
    const sessionGates = this.reviewSessionGates(projectId, sessionId);
    const scope = sessionGates.length > 0 ? sessionGates : this.store.getPendingGates(projectId);
    return scope.filter((gate) => gate.status === "pending");
  }

  private markReviewSessionMember(gate: HumanGateItem, reviewSessionId: string): HumanGateItem {
    const payload = parseGatePayload(gate.payload);
    if (payload.reviewSessionId === reviewSessionId) return gate;
    return this.gateService.systemAnnotate(gate.id, {
      actor: "telegram_callback_router",
      reason: "telegram gate assigned to review session",
      patch: {
        payload: JSON.stringify({
          ...payload,
          reviewSessionId,
        }),
      },
    });
  }

  private markTelegramReviewOpened(gate: HumanGateItem, reviewSessionId?: string): HumanGateItem {
    const payload = parseGatePayload(gate.payload);
    const nextPayload = {
      ...payload,
      ...(payload.telegramReviewOpenedAt ? {} : { telegramReviewOpenedAt: now() }),
      ...(reviewSessionId && payload.reviewSessionId !== reviewSessionId ? { reviewSessionId } : {}),
    };
    if (JSON.stringify(payload) === JSON.stringify(nextPayload)) return gate;
    return this.gateService.systemAnnotate(gate.id, {
      actor: "telegram_callback_router",
      reason: "telegram card displayed for review dwell tracking",
      patch: {
        payload: JSON.stringify(nextPayload),
      },
    });
  }

  private async handleRejectMenu(gateId: string, ref: MessageRef): Promise<void> {
    const gate = this.store.getGate(gateId);
    if (!gate) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到闸门：${gateId}`) });
      return;
    }
    const projectId = this.store.getCycle(gate.cycleId)?.projectId;
    const marked = this.markTelegramReviewOpened(gate);
    await this.platform.editCard(ref, gateRejectReasonCard({
      title: marked.title,
      body: formatGateDecisionRequestText(marked, { projectId }),
      gateId: marked.id,
      isBlocking: marked.blocking === 1,
      actionUrl: gateUrl(this.baseUrl, marked.id, projectId),
    }));
  }

  private async handleDefer(gateId: string, ref: MessageRef, callbackWarning?: string | null): Promise<void> {
    const gate = this.store.getGate(gateId);
    if (!gate) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到闸门：${gateId}`) });
      return;
    }
    const payload = parseGatePayload(gate.payload);
    const failureContext = this.callbackFailureContextForGate(gate, ref);
    try {
      const result = this.gateService.defer(gate.id, null, {
        via: "telegram",
        actor: "human_telegram",
        reviewOpenedAt: payload.telegramReviewOpenedAt,
      });
      const projectId = this.store.getCycle(gate.cycleId)?.projectId ?? "system";
      if (await this.maybeContinueReviewSession(projectId, ref, callbackWarning)) return;
      await this.bestEffortTelegramFeedback("editCard(defer receipt)", () =>
        this.platform.editCard(ref, plainTextCard("已顺延", [
          `闸门「${result.gate.title}」已顺延至 ${result.gate.deferUntil ?? "下个窗口"}。`,
          callbackWarning ? `注意：${callbackWarning}` : "",
        ].filter(Boolean).join("\n"))), failureContext);
    } catch (error) {
      await this.bestEffortTelegramFeedback("editCard(defer error)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(`顺延失败：${error instanceof Error ? error.message : String(error)}`),
        }), failureContext);
    }
  }

  private async handleRevoke(gateId: string, ref: MessageRef, callbackWarning?: string | null): Promise<void> {
    const gate = this.store.getGate(gateId);
    if (!gate) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到闸门：${gateId}`) });
      return;
    }
    const failureContext = this.callbackFailureContextForGate(gate, ref);
    try {
      const result = this.gateService.revoke(gate.id, {
        via: "telegram",
        actor: "human_telegram",
      });
      await this.bestEffortTelegramFeedback("editCard(revoke receipt)", () =>
        this.platform.editCard(ref, plainTextCard("已撤销 apply", [
          `闸门「${result.gate.title}」已回到待审批状态，草稿退出 apply 队列。`,
          callbackWarning ? `注意：${callbackWarning}` : "",
        ].filter(Boolean).join("\n"))), failureContext);
    } catch (error) {
      await this.bestEffortTelegramFeedback("editCard(revoke error)", () =>
        this.platform.editCard(ref, {
          body: escapeMarkdownV2(`撤销失败：${error instanceof Error ? error.message : String(error)}`),
        }), failureContext);
    }
  }

  private reviewGateCard(gate: HumanGateItem, projectId: string, progressLabel?: string) {
    const payload = parseGatePayload(gate.payload);
    return gateCard({
      title: gate.title,
      body: formatGateDecisionRequestText(gate, { projectId }),
      gateId: gate.id,
      gateType: gate.type,
      isBlocking: gate.blocking === 1,
      actionUrl: gateUrl(this.baseUrl, gate.id, projectId),
      riskKey: payload.riskKey,
      reviewId: payload.reviewId,
      progressLabel,
    });
  }

  private async maybeContinueReviewSession(projectId: string, ref: MessageRef, callbackWarning?: string | null): Promise<boolean> {
    const session = this.store.getOpenReviewSession(projectId);
    if (!session) return false;
    const sessionGates = this.reviewSessionGates(projectId, session.id);
    const scopedGates = sessionGates.length > 0 ? sessionGates : this.store.listGates(projectId);
    const pending = this.pendingGatesForReviewSession(projectId, session.id);
    if (pending.length === 0) {
      const deferred = scopedGates.filter((gate) => gate.status === "deferred").length;
      const resolved = Math.max(0, session.gatesTotal - deferred);
      this.store.updateReviewSession(session.id, {
        closedAt: now(),
        gatesResolved: resolved,
        gatesDeferred: deferred,
      });
      await this.platform.editCard(ref, plainTextCard("审批会话完成", [
        `${resolved} 已处理 / ${deferred} 顺延。`,
        callbackWarning ? `注意：${callbackWarning}` : "",
      ].filter(Boolean).join("\n")));
      return true;
    }

    const nextGate = this.markTelegramReviewOpened(pending[0], session.id);
    const completed = Math.max(0, session.gatesTotal - pending.length);
    await this.platform.editCard(ref, this.reviewGateCard(
      nextGate,
      projectId,
      `${Math.min(completed + 1, session.gatesTotal)}/${session.gatesTotal}`,
    ));
    return true;
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
    if (
      data.startsWith("perm:allow:") ||
      data.startsWith("perm:deny:") ||
      data.startsWith("perm:reject:") ||
      data.startsWith("perm:defer:") ||
      data.startsWith("perm:revoke:") ||
      data.startsWith("perm:reason:") ||
      data.startsWith("nav:gate:")
    ) {
      const target = data.startsWith("perm:reason:")
        ? data.replace(/^perm:reason:[^:]+:/, "")
        : data.replace(/^(perm:allow:|perm:deny:|perm:reject:|perm:defer:|perm:revoke:|nav:gate:)/, "");
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
        const marked = this.markTelegramReviewOpened(gate);
        const payload = parseGatePayload(marked.payload);
        await this.platform.sendCard(chatId, gateCard({
          title: marked.title,
          body: formatGateDecisionRequestText(marked, { projectId: project.id }),
          gateId: marked.id,
          gateType: marked.type,
          isBlocking: marked.blocking === 1,
          actionUrl: gateUrl(this.baseUrl, marked.id, project.id),
          riskKey: payload.riskKey,
          reviewId: payload.reviewId,
        }));
      }
    }
  }

  private async handleReviewCmd(chatId: string, projectId?: string): Promise<void> {
    const projects = projectId
      ? this.store.getProjects().filter((project) => project.id === projectId)
      : this.store.getProjects().slice().reverse();
    if (projectId && projects.length === 0) {
      await this.platform.sendText(chatId, escapeMarkdownV2(`未找到项目：${projectId}`));
      return;
    }
    for (const project of projects) {
      const pending = this.store.getPendingGates(project.id);
      if (pending.length === 0) continue;
      const session = this.store.getOpenReviewSession(project.id) ?? this.store.createReviewSession({
        id: `review_manual_${project.id.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 64)}_${Date.now().toString(36)}`,
        projectId: project.id,
        source: "manual",
        openedAt: now(),
        closedAt: null,
        gatesTotal: pending.length,
        gatesResolved: 0,
        gatesDeferred: 0,
        digestMessageId: null,
        summaryMessageId: null,
      });
      const sessionPending = this.pendingGatesForReviewSession(project.id, session.id)
        .map((gate) => this.markReviewSessionMember(gate, session.id));
      const firstGate = this.markTelegramReviewOpened(sessionPending[0] ?? pending[0], session.id);
      await this.platform.sendCard(chatId, this.reviewGateCard(firstGate, project.id, `1/${session.gatesTotal}`));
      return;
    }
    await this.platform.sendText(chatId, escapeMarkdownV2(projectId ? `项目 ${projectId} 当前没有待审批闸门。` : "当前没有待审批闸门。"));
  }

  private async handleWindowCmd(chatId: string): Promise<void> {
    const state = reviewWindowState(new Date());
    const nextStart = nextReviewWindowStartIso(new Date());
    const lines = [
      `当前窗口：${state.inWindow ? `${state.windowDate} ${state.windowLabel}` : "窗口外"}（${state.timezone}）`,
      `下个窗口开始：${nextStart}`,
      `暂停状态：${reviewPaused(this.store) ? "已暂停" : "正常"}`,
    ];
    for (const project of this.store.getProjects()) {
      const pending = this.store.getPendingGates(project.id);
      const deferred = this.store.listGates(project.id).filter((gate) => gate.status === "deferred").length;
      lines.push(`${project.id}: pending ${pending.length} / deferred ${deferred}`);
    }
    await this.platform.sendText(chatId, escapeMarkdownV2(lines.join("\n")));
  }

  private async handlePauseCmd(chatId: string): Promise<void> {
    process.env.ALAYA_REVIEW_PAUSED = "true";
    this.store.setReviewPauseState(true, "human_telegram");
    await this.platform.sendText(chatId, escapeMarkdownV2("已暂停审批窗口提醒与 missed_windows 升级。"));
  }

  private async handleResumeCmd(chatId: string): Promise<void> {
    process.env.ALAYA_REVIEW_PAUSED = "false";
    this.store.setReviewPauseState(false, "human_telegram");
    await this.platform.sendText(chatId, escapeMarkdownV2("已恢复审批窗口提醒与 missed_windows 统计。"));
  }
}
