import fs from "node:fs";
import path from "node:path";
import { escapeMarkdownV2 } from "./telegram-simple";
import { gateCard, resolvedGateCard } from "./card";
import type { AlayaEvent, MessageRef, MessagingPlatform } from "./types";

export interface NotificationEmitFailure {
  event: AlayaEvent;
  adapter: string;
  chatId: string;
  error: unknown;
}

export type NotificationFailureHandler = (failure: NotificationEmitFailure) => void | Promise<void>;
export type NotificationSendGuard = (event: AlayaEvent) => boolean | Promise<boolean>;

export interface NotificationBusOptions {
  shouldSend?: NotificationSendGuard;
  maxRetries?: number;
  retryBaseMs?: number;
}

export class NotificationBus {
  private adapters: MessagingPlatform[] = [];
  private chatIds: string[] = [];
  private notifiedGateDeliveryKeys = new Set<string>();
  private notifiedSafetyDeliveryKeys = new Set<string>();
  private gateMessageRefs = new Map<string, Map<string, MessageRef>>();
  private readonly gateMessageRefsPath?: string;
  private pendingGateSends = new Map<string, Promise<MessageRef>>();
  private terminalGateEvents = new Map<string, AlayaEvent>();
  private retryCounts = new Map<string, number>();
  private scheduledRetryKeys = new Set<string>();

  constructor(
    private readonly failureHandler?: NotificationFailureHandler,
    private readonly options: NotificationBusOptions = {},
  ) {
    this.gateMessageRefsPath = this.resolveGateMessageRefsPath();
    this.loadGateMessageRefs();
  }

  addAdapter(adapter: MessagingPlatform, chatIds: string[]): this {
    this.adapters.push(adapter);
    this.chatIds.push(...chatIds.filter(Boolean));
    return this;
  }

  async start(): Promise<void> {
    await Promise.all(this.adapters.map((adapter) => adapter.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.adapters.map((adapter) => adapter.stop()));
  }

  knownGateIds(): string[] {
    return Array.from(this.gateMessageRefs.keys());
  }

  async emit(event: AlayaEvent): Promise<void> {
    if (this.adapters.length === 0 || this.chatIds.length === 0) return;
    if (!(await this.shouldSend(event))) return;

    for (const adapter of this.adapters) {
      for (const chatId of this.chatIds) {
        await this.emitToWithFailureHandling(event, adapter, chatId);
      }
    }
  }

  private async emitToWithFailureHandling(event: AlayaEvent, adapter: MessagingPlatform, chatId: string): Promise<void> {
    try {
      await this.emitTo(event, adapter, chatId);
      this.retryCounts.delete(this.retryKey(event, adapter.name(), chatId));
    } catch (error) {
      console.error("[NotificationBus] emit failed:", error instanceof Error ? error.message : String(error));
      try {
        await this.failureHandler?.({
          event,
          adapter: adapter.name(),
          chatId,
          error,
        });
      } catch (auditError) {
        console.error("[NotificationBus] failure audit failed:", auditError instanceof Error ? auditError.message : String(auditError));
      }
      this.scheduleRetry(event, adapter, chatId);
    }
  }

  private async emitTo(event: AlayaEvent, adapter: MessagingPlatform, chatId: string): Promise<void> {
    if (!(await this.shouldSend(event))) return;
    if (event.type === "gate_opened" && event.gateId) {
      const deliveryKey = this.deliveryKey(event.gateId, adapter.name(), chatId);
      if (this.notifiedGateDeliveryKeys.has(deliveryKey)) return;
      let pendingSend = this.pendingGateSends.get(deliveryKey);
      if (!pendingSend) {
        pendingSend = adapter.sendCard(chatId, gateCard({
          title: event.title,
          body: event.body,
          gateId: event.gateId,
          gateType: event.gateType ?? "meaning",
          isBlocking: event.isBlocking ?? false,
          actionUrl: event.actionUrl,
          riskKey: event.meta?.riskKey,
          reviewId: event.meta?.reviewId,
        })).then((ref) => {
          this.rememberGateMessage(event.gateId!, adapter.name(), chatId, ref);
          this.notifiedGateDeliveryKeys.add(deliveryKey);
          return ref;
        }).finally(() => {
          this.pendingGateSends.delete(deliveryKey);
        });
        this.pendingGateSends.set(deliveryKey, pendingSend);
      }
      const ref = await pendingSend;
      const terminalEvent = this.terminalGateEvents.get(event.gateId);
      if (terminalEvent) {
        await this.emitResolvedGateReceipt(adapter, chatId, ref, terminalEvent);
      }
      return;
    }

    if (event.type === "gate_resolved" && event.gateId) {
      this.terminalGateEvents.set(event.gateId, event);
      const ref = this.gateMessage(event.gateId, adapter.name(), chatId);
      if (ref) {
        await this.emitResolvedGateReceipt(adapter, chatId, ref, event);
        return;
      }
      const pendingSend = this.pendingGateSends.get(this.deliveryKey(event.gateId, adapter.name(), chatId));
      if (pendingSend) {
        try {
          await pendingSend;
          return;
        } catch (pendingError) {
          console.warn("[NotificationBus] pending gate card send failed before resolution receipt:", pendingError instanceof Error ? pendingError.message : String(pendingError));
        }
      }
      await adapter.sendText(chatId, this.renderText(event));
      return;
    }

    if (event.type === "safety_mode") {
      const safetyKey = `${event.projectId}:${event.gateId ?? ""}:${event.title}:${event.body}`;
      const deliveryKey = this.deliveryKey(safetyKey, adapter.name(), chatId);
      if (this.notifiedSafetyDeliveryKeys.has(deliveryKey)) return;
      await adapter.sendText(chatId, this.renderText(event));
      this.notifiedSafetyDeliveryKeys.add(deliveryKey);
      return;
    }

    await adapter.sendText(chatId, this.renderText(event));
  }

  private scheduleRetry(event: AlayaEvent, adapter: MessagingPlatform, chatId: string): void {
    const key = this.retryKey(event, adapter.name(), chatId);
    const nextAttempt = (this.retryCounts.get(key) ?? 0) + 1;
    if (nextAttempt > this.maxRetries()) return;
    if (this.scheduledRetryKeys.has(key)) return;
    this.retryCounts.set(key, nextAttempt);
    this.scheduledRetryKeys.add(key);
    const timer = setTimeout(() => {
      this.scheduledRetryKeys.delete(key);
      void this.emitToWithFailureHandling(event, adapter, chatId);
    }, this.retryBaseMs() * nextAttempt);
    timer.unref?.();
  }

  private async shouldSend(event: AlayaEvent): Promise<boolean> {
    if (!this.options.shouldSend) return true;
    try {
      return await this.options.shouldSend(event);
    } catch (error) {
      console.warn("[NotificationBus] send guard failed:", error instanceof Error ? error.message : String(error));
      return true;
    }
  }

  private gateMessageKey(adapterName: string, chatId: string): string {
    return `${adapterName}:${chatId}`;
  }

  private deliveryKey(eventKey: string, adapterName: string, chatId: string): string {
    return `${eventKey}:${this.gateMessageKey(adapterName, chatId)}`;
  }

  private retryKey(event: AlayaEvent, adapterName: string, chatId: string): string {
    const eventKey = `${event.type}:${event.projectId}:${event.gateId ?? ""}:${event.title}:${event.body}`;
    return this.deliveryKey(eventKey, adapterName, chatId);
  }

  private maxRetries(): number {
    const configured = this.options.maxRetries ?? Number(process.env.ALAYA_NOTIFICATION_RETRY_ATTEMPTS ?? 3);
    return Number.isFinite(configured) ? Math.max(0, Math.trunc(configured)) : 3;
  }

  private retryBaseMs(): number {
    const configured = this.options.retryBaseMs ?? Number(process.env.ALAYA_NOTIFICATION_RETRY_BASE_MS ?? 5_000);
    return Number.isFinite(configured) ? Math.max(0, Math.trunc(configured)) : 5_000;
  }

  private rememberGateMessage(gateId: string, adapterName: string, chatId: string, ref: MessageRef): void {
    const refs = this.gateMessageRefs.get(gateId) ?? new Map<string, MessageRef>();
    refs.set(this.gateMessageKey(adapterName, chatId), ref);
    this.gateMessageRefs.set(gateId, refs);
    this.persistGateMessageRefs();
  }

  private gateMessage(gateId: string, adapterName: string, chatId: string): MessageRef | undefined {
    return this.gateMessageRefs.get(gateId)?.get(this.gateMessageKey(adapterName, chatId));
  }

  private resolveGateMessageRefsPath(): string | undefined {
    const explicitPath = process.env.ALAYA_NOTIFICATION_REF_PATH?.trim();
    if (explicitPath) return explicitPath;
    const stateDir = process.env.ALAYA_STATE_DIR?.trim();
    if (!stateDir) return undefined;
    return path.join(stateDir, "telegram-gate-message-refs.json");
  }

  private loadGateMessageRefs(): void {
    if (!this.gateMessageRefsPath || !fs.existsSync(this.gateMessageRefsPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.gateMessageRefsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [gateId, keyedRefs] of Object.entries(parsed)) {
        if (!keyedRefs || typeof keyedRefs !== "object" || Array.isArray(keyedRefs)) continue;
        const refs = new Map<string, MessageRef>();
        for (const [key, value] of Object.entries(keyedRefs)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const chatId = typeof (value as { chatId?: unknown }).chatId === "string"
            ? (value as { chatId: string }).chatId
            : "";
          const messageId = Number((value as { messageId?: unknown }).messageId);
          if (!chatId || !Number.isInteger(messageId) || messageId <= 0) continue;
          refs.set(key, { chatId, messageId });
        }
        if (refs.size > 0) this.gateMessageRefs.set(gateId, refs);
      }
    } catch (error) {
      console.warn("[NotificationBus] failed to load persisted gate message refs:", error instanceof Error ? error.message : String(error));
    }
  }

  private persistGateMessageRefs(): void {
    if (!this.gateMessageRefsPath) return;
    try {
      const dir = path.dirname(this.gateMessageRefsPath);
      fs.mkdirSync(dir, { recursive: true });
      const serializable: Record<string, Record<string, MessageRef>> = {};
      for (const [gateId, refs] of Array.from(this.gateMessageRefs.entries())) {
        serializable[gateId] = Object.fromEntries(Array.from(refs.entries()));
      }
      fs.writeFileSync(this.gateMessageRefsPath, JSON.stringify(serializable, null, 2));
    } catch (error) {
      console.warn("[NotificationBus] failed to persist gate message refs:", error instanceof Error ? error.message : String(error));
    }
  }

  private async emitResolvedGateReceipt(
    adapter: MessagingPlatform,
    chatId: string,
    ref: MessageRef,
    event: AlayaEvent,
  ): Promise<void> {
    try {
      await adapter.editCard(ref, resolvedGateCard({
        title: event.title,
        body: event.body,
        actionUrl: event.actionUrl,
      }));
    } catch (editError) {
      const message = editError instanceof Error ? editError.message : String(editError);
      if (/message is not modified/i.test(message)) return;
      console.warn("[NotificationBus] gate card edit failed; sending terminal receipt:", message);
      await adapter.sendText(chatId, this.renderText(event));
    }
  }

  private renderText(event: AlayaEvent): string {
    const emoji = {
      safety_mode: "🛑",
      llm_budget_exceeded: "💸",
      cycle_completed: "✅",
      knowledge_promoted: "📚",
      gate_opened: "🔔",
      gate_resolved: "✅",
    }[event.type] ?? "📢";
    const lines = [
      `${emoji} *${escapeMarkdownV2(event.title)}*`,
      escapeMarkdownV2(event.body),
    ];
    if (event.actionUrl) lines.push("", escapeMarkdownV2(`在 Web UI 查看：${event.actionUrl}`));
    return lines.join("\n");
  }
}
