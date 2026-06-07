import type { HumanGateItem } from "@shared/schema";
import { HumanGateService } from "../humanGateService";
import type { IStorage } from "../storage";
import { storage } from "../storage";
import { escapeMarkdownV2 } from "./telegram-simple";
import { gateCard, statusCard } from "./card";
import type { MessageRef, MessagingPlatform } from "./types";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function gateUrl(baseUrl: string, gateId?: string): string {
  const suffix = gateId ? `?gate=${encodeURIComponent(gateId)}` : "";
  return `${trimTrailingSlash(baseUrl)}/#/human-gates${suffix}`;
}

function parsePayload(payload: string): Record<string, any> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function gateBody(gate: HumanGateItem): string {
  const payload = parsePayload(gate.payload);
  return String(
    payload.summary ??
    payload.reason ??
    payload.requiredAction ??
    payload.auditSummary?.whyNow ??
    gate.title,
  );
}

export class CallbackRouter {
  constructor(
    private platform: MessagingPlatform,
    private store: IStorage = storage,
    private gateService = new HumanGateService(store),
    private baseUrl = process.env.ALAYA_BASE_URL ?? "http://localhost:5000",
  ) {}

  async route(callbackId: string, data: string, ref: MessageRef): Promise<void> {
    if (callbackId) {
      await this.platform.answerCallback(callbackId);
    }

    if (data.startsWith("perm:allow:")) {
      await this.handlePerm(data.replace("perm:allow:", ""), "approve", ref);
    } else if (data.startsWith("perm:deny:")) {
      await this.handlePerm(data.replace("perm:deny:", ""), "reject", ref);
    } else if (data.startsWith("nav:gate:")) {
      await this.handleNavGate(data.replace("nav:gate:", ""), ref.chatId);
    } else if (data.startsWith("cmd:/status")) {
      await this.handleStatusCmd(ref.chatId);
    } else if (data.startsWith("cmd:/gates")) {
      await this.handleGatesCmd(ref.chatId);
    }
  }

  private async handlePerm(gateId: string, action: "approve" | "reject", ref: MessageRef): Promise<void> {
    const gate = this.store.getGate(gateId);
    if (!gate) {
      await this.platform.editCard(ref, { body: escapeMarkdownV2(`未找到闸门：${gateId}`) });
      return;
    }
    if (gate.blocking === 1 || gate.type !== "meaning") {
      await this.platform.sendText(ref.chatId, escapeMarkdownV2(`请在 Web UI 处理该闸门：${gateUrl(this.baseUrl, gate.id)}`));
      return;
    }

    await this.platform.sendTyping?.(ref.chatId);
    await this.platform.editCard(ref, { body: escapeMarkdownV2(`正在处理 ${gate.id}...`) });

    try {
      const result = action === "approve"
        ? this.gateService.approve(gate.id, { via: "telegram", actor: "human_telegram" })
        : this.gateService.reject(gate.id, { via: "telegram", actor: "human_telegram" });
      const label = action === "approve" ? "✅ 已批准" : "❌ 已否决";
      const dryRunSuffix = result.dryRun ? "（dry-run，未写入）" : "";
      await this.platform.editCard(ref, {
        body: `${escapeMarkdownV2(label)} — ${escapeMarkdownV2(`闸门 ${gate.id} ${action === "approve" ? "已通过" : "已拒绝"}${dryRunSuffix}`)}\n_${escapeMarkdownV2(`via Telegram · ${new Date().toLocaleTimeString("zh-CN")}`)}_`,
      });
    } catch (error) {
      await this.platform.editCard(ref, {
        body: escapeMarkdownV2(`处理失败：${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }

  private async handleNavGate(gateId: string, chatId: string): Promise<void> {
    await this.platform.sendText(chatId, escapeMarkdownV2(`请在 Web UI 处理该闸门：${gateUrl(this.baseUrl, gateId)}`));
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
        await this.platform.sendCard(chatId, gateCard({
          title: gate.title,
          body: gateBody(gate),
          gateId: gate.id,
          gateType: gate.type,
          isBlocking: gate.blocking === 1,
          actionUrl: gateUrl(this.baseUrl, gate.id),
        }));
      }
    }
  }
}
