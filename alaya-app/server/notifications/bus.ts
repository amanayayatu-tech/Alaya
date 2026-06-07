import { escapeMarkdownV2 } from "./telegram-simple";
import { gateCard } from "./card";
import type { AlayaEvent, MessagingPlatform } from "./types";

export interface NotificationEmitFailure {
  event: AlayaEvent;
  adapter: string;
  chatId: string;
  error: unknown;
}

export type NotificationFailureHandler = (failure: NotificationEmitFailure) => void | Promise<void>;

export class NotificationBus {
  private adapters: MessagingPlatform[] = [];
  private chatIds: string[] = [];
  private notifiedGateIds = new Set<string>();
  private notifiedSafetyKeys = new Set<string>();

  constructor(private readonly failureHandler?: NotificationFailureHandler) {}

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

  async emit(event: AlayaEvent): Promise<void> {
    if (this.adapters.length === 0 || this.chatIds.length === 0) return;
    if (event.type === "gate_opened" && event.gateId) {
      if (this.notifiedGateIds.has(event.gateId)) return;
      this.notifiedGateIds.add(event.gateId);
    }
    if (event.type === "safety_mode") {
      const key = `${event.projectId}:${event.gateId ?? ""}:${event.title}:${event.body}`;
      if (this.notifiedSafetyKeys.has(key)) return;
      this.notifiedSafetyKeys.add(key);
    }

    for (const adapter of this.adapters) {
      for (const chatId of this.chatIds) {
        try {
          if (event.type === "gate_opened" && event.gateId) {
            await adapter.sendCard(chatId, gateCard({
              title: event.title,
              body: event.body,
              gateId: event.gateId,
              gateType: event.gateType ?? "meaning",
              isBlocking: event.isBlocking ?? false,
              actionUrl: event.actionUrl,
            }));
          } else {
            await adapter.sendText(chatId, this.renderText(event));
          }
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
        }
      }
    }
  }

  private renderText(event: AlayaEvent): string {
    const emoji = {
      safety_mode: "🛑",
      llm_budget_exceeded: "💸",
      cycle_completed: "✅",
      knowledge_promoted: "📚",
      gate_opened: "🔔",
    }[event.type] ?? "📢";
    const lines = [
      `${emoji} *${escapeMarkdownV2(event.title)}*`,
      escapeMarkdownV2(event.body),
    ];
    if (event.actionUrl) lines.push("", escapeMarkdownV2(`在 Web UI 查看：${event.actionUrl}`));
    return lines.join("\n");
  }
}
