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

export function compactReviewCallbackTarget(reviewId: string, prefix = "kr:q:"): string {
  const direct = `${prefix}${reviewId}`;
  if (Buffer.byteLength(direct, "utf8") <= 64) return reviewId;
  return `t:${createHash("sha1").update(reviewId).digest("hex").slice(0, 18)}`;
}

export function compactProjectCallbackTarget(projectId: string, prefix = "cmd:/review:"): string {
  const direct = `${prefix}${projectId}`;
  if (Buffer.byteLength(direct, "utf8") <= 64) return projectId;
  return `t:${createHash("sha1").update(projectId).digest("hex").slice(0, 18)}`;
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
  progressLabel?: string;
}): AlayaCard {
  const title = `${event.isBlocking ? "🔴" : "🟡"} ${event.progressLabel ? `${event.progressLabel} · ` : ""}${event.title}`;
  const card = new CardBuilder()
    .title(escapeMarkdownV2(title), event.isBlocking ? "red" : "orange")
    .body(escapeMarkdownV2(event.body))
    .footer(
      event.actionUrl
        ? `[在 Web UI 查看详情](${escapeMarkdownV2LinkUrl(event.actionUrl)})`
        : escapeMarkdownV2(`闸门类型: ${event.gateType}${event.isBlocking ? " · 阻塞型" : ""}`),
    );

  if (event.gateType === "risk" && event.riskKey === "knowledge_conflict_review" && event.reviewId) {
    const quarantineTarget = compactReviewCallbackTarget(event.reviewId, "kr:q:");
    const mergeTarget = compactReviewCallbackTarget(event.reviewId, "kr:m:");
    card.buttons(
      btn.primary("✅ 隔离当前", `kr:q:${quarantineTarget}`),
      btn.default("↔️ 保留既有", `kr:m:${mergeTarget}`),
    );
    card.buttons(btn.default("在 Web 查看", `nav:gate:${compactGateCallbackTarget(event.gateId, "nav:gate:")}`));
  } else if (["meaning", "direction", "risk"].includes(event.gateType)) {
    const allowTarget = compactGateCallbackTarget(event.gateId, "perm:allow:");
    const rejectTarget = compactGateCallbackTarget(event.gateId, "perm:reject:");
    const deferTarget = compactGateCallbackTarget(event.gateId, "perm:defer:");
    card.buttons(
      btn.primary("✅ 批准", `perm:allow:${allowTarget}`),
      btn.danger("❌ 否决", `perm:reject:${rejectTarget}`),
      btn.default("⏭ 顺延", `perm:defer:${deferTarget}`),
    );
    if (event.isBlocking) {
      card.buttons(btn.default("🔍 详情", `nav:gate:${compactGateCallbackTarget(event.gateId, "nav:gate:")}`));
    }
  } else {
    card.buttons(btn.default("在 Web 处理", `nav:gate:${compactGateCallbackTarget(event.gateId, "nav:gate:")}`));
  }

  return card.build();
}

export function gateRejectReasonCard(event: {
  title: string;
  body: string;
  gateId: string;
  isBlocking: boolean;
  actionUrl?: string;
}): AlayaCard {
  const title = `${event.isBlocking ? "🔴" : "🟡"} 选择否决原因 · ${event.title}`;
  const reasonTarget = (code: string) => compactGateCallbackTarget(event.gateId, `perm:reason:${code}:`);
  const card = new CardBuilder()
    .title(escapeMarkdownV2(title), "red")
    .body(escapeMarkdownV2(event.body))
    .buttons(
      btn.danger("方向错", `perm:reason:wrong_direction:${reasonTarget("wrong_direction")}`),
      btn.danger("证据不足", `perm:reason:weak_evidence:${reasonTarget("weak_evidence")}`),
    )
    .buttons(
      btn.default("时机不对", `perm:reason:not_now:${reasonTarget("not_now")}`),
      btn.danger("风险太高", `perm:reason:too_risky:${reasonTarget("too_risky")}`),
    );
  if (event.actionUrl) {
    card.footer(`[在 Web UI 查看详情](${escapeMarkdownV2LinkUrl(event.actionUrl)})`);
  }
  return card.build();
}

export function speculativeQueuedReceiptCard(event: {
  title: string;
  body: string;
  gateId: string;
}): AlayaCard {
  const revokeTarget = compactGateCallbackTarget(event.gateId, "perm:revoke:");
  return new CardBuilder()
    .title(escapeMarkdownV2(`✅ ${event.title}`), "green")
    .body(escapeMarkdownV2(event.body))
    .buttons(btn.default("↩️ 撤销", `perm:revoke:${revokeTarget}`))
    .build();
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
