import { createHash } from "node:crypto";
import { escapeMarkdownV2, escapeMarkdownV2LinkUrl } from "./telegram-simple";
import type { AlayaCard, CardButton } from "./types";

export class CardBuilder {
  private card: AlayaCard = { body: "" };

  title(text: string, color = "blue"): this {
    this.card.title = { text, color };
    return this;
  }

  body(markdown: string): this {
    this.card.body = markdown;
    return this;
  }

  buttons(...row: CardButton[]): this {
    if (!this.card.buttons) this.card.buttons = [];
    this.card.buttons.push(row);
    return this;
  }

  footer(text: string): this {
    this.card.footer = text;
    return this;
  }

  build(): AlayaCard {
    return {
      ...this.card,
      buttons: this.card.buttons?.map((row) => row.map((button) => ({ ...button }))),
    };
  }
}

function assertCallbackData(data: string): string {
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error(`Telegram callback_data exceeds 64 bytes: ${data.slice(0, 32)}...`);
  }
  return data;
}

export function compactGateCallbackTarget(gateId: string, prefix = "perm:allow:"): string {
  const direct = `${prefix}${gateId}`;
  if (Buffer.byteLength(direct, "utf8") <= 64) return gateId;
  return `t:${createHash("sha1").update(gateId).digest("hex").slice(0, 18)}`;
}

export const btn = {
  primary: (text: string, data: string): CardButton => ({ text, type: "primary", callbackData: assertCallbackData(data) }),
  default: (text: string, data: string): CardButton => ({ text, type: "default", callbackData: assertCallbackData(data) }),
  danger: (text: string, data: string): CardButton => ({ text, type: "danger", callbackData: assertCallbackData(data) }),
};

export function gateCard(event: {
  title: string;
  body: string;
  gateId: string;
  gateType: string;
  isBlocking: boolean;
  actionUrl?: string;
  riskKey?: string;
  reviewId?: string;
}): AlayaCard {
  const title = `${event.isBlocking ? "🔴" : "🟡"} ${event.title}`;
  const card = new CardBuilder()
    .title(escapeMarkdownV2(title), event.isBlocking ? "red" : "orange")
    .body(escapeMarkdownV2(event.body))
    .footer(
      event.actionUrl
        ? `[在 Web UI 查看详情](${escapeMarkdownV2LinkUrl(event.actionUrl)})`
        : escapeMarkdownV2(`闸门类型: ${event.gateType}${event.isBlocking ? " · 阻塞型" : ""}`),
    );

  if (event.gateType === "risk" && event.riskKey === "knowledge_conflict_review" && event.reviewId) {
    card.buttons(
      btn.primary("✅ 隔离当前", `kr:q:${event.reviewId}`),
      btn.default("↔️ 保留既有", `kr:m:${event.reviewId}`),
    );
    card.buttons(btn.default("在 Web 查看", `nav:gate:${compactGateCallbackTarget(event.gateId, "nav:gate:")}`));
  } else if (["meaning", "direction", "risk"].includes(event.gateType)) {
    const allowTarget = compactGateCallbackTarget(event.gateId, "perm:allow:");
    const denyTarget = compactGateCallbackTarget(event.gateId, "perm:deny:");
    card.buttons(
      btn.primary("✅ 批准", `perm:allow:${allowTarget}`),
      btn.danger("❌ 否决", `perm:deny:${denyTarget}`),
    );
  } else {
    card.buttons(btn.default("在 Web 处理", `nav:gate:${compactGateCallbackTarget(event.gateId, "nav:gate:")}`));
  }

  return card.build();
}

export function statusCard(state: {
  projectId: string;
  cycle: number;
  pendingGates: number;
  knowledgeCount: number;
  lastCycleAt: string;
}): AlayaCard {
  return new CardBuilder()
    .title(escapeMarkdownV2("📊 Alaya 飞轮状态"), "blue")
    .body(
      `*项目*: ${escapeMarkdownV2(state.projectId)}\n` +
      `*当前 Cycle*: \\#${escapeMarkdownV2(state.cycle)}\n` +
      `*待处理闸门*: ${escapeMarkdownV2(state.pendingGates)} 个\n` +
      `*知识条目*: ${escapeMarkdownV2(state.knowledgeCount)}\n` +
      `*最后运行*: ${escapeMarkdownV2(state.lastCycleAt)}`,
    )
    .build();
}

export function plainTextCard(title: string, body: string): AlayaCard {
  return new CardBuilder()
    .title(escapeMarkdownV2(title))
    .body(escapeMarkdownV2(body))
    .build();
}

export function resolvedGateCard(event: { title: string; body: string; actionUrl?: string }): AlayaCard {
  const card = new CardBuilder()
    .title(escapeMarkdownV2(`✅ ${event.title}`), "green")
    .body(escapeMarkdownV2(event.body));
  if (event.actionUrl) {
    card.footer(`[在 Web UI 查看详情](${escapeMarkdownV2LinkUrl(event.actionUrl)})`);
  }
  return card.build();
}
