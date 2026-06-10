import fs from "node:fs";
import path from "node:path";
import { assertNetworkAllowed, checkCapability, CapabilityDeniedError } from "../security/capabilities";
import {
  TELEGRAM_API_HOST,
  assertTelegramHostAllowlisted,
  assertValidTelegramToken,
} from "./telegram-simple";
import type { AlayaCard, CallbackHandler, CardButton, MessageRef, MessagingPlatform, SentMessage } from "./types";

interface TelegramChat {
  id: number | string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number | string };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from?: { id: number | string };
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

function offsetPath(): string {
  const dir = process.env.ALAYA_STATE_DIR?.trim() || process.cwd();
  return path.join(dir, "telegram-update-offset.json");
}

function readOffset(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(offsetPath(), "utf8")) as { offset?: number };
    return typeof parsed.offset === "number" && Number.isFinite(parsed.offset) ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number): void {
  const file = offsetPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ offset }), "utf8");
}

function telegramHostCheckUrl(method: string): string {
  return `https://${TELEGRAM_API_HOST}/${method}`;
}

function telegramRequestAttempts(): number {
  const configured = Number(process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS ?? 3);
  return Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 3;
}

function telegramRetryBaseMs(): number {
  const configured = Number(process.env.ALAYA_TELEGRAM_RETRY_BASE_MS ?? 300);
  return Number.isFinite(configured) ? Math.max(0, Math.trunc(configured)) : 300;
}

function isRetryableTelegramStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class TelegramAdapter implements MessagingPlatform {
  private callbackHandlers: CallbackHandler[] = [];
  private polling = false;
  private offset = readOffset();

  constructor(
    private token: string,
    private defaultChatId: string,
  ) {
    assertValidTelegramToken(token);
  }

  name(): string {
    return "telegram";
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.notificationDryRun("sendMessage")) return;
    await this.telegramRequest("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });
  }

  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    if (this.notificationDryRun("sendMessage")) return { chatId, messageId: 0 };
    const message = await this.telegramRequest<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: this.renderCardText(card),
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: card.buttons ? this.buildInlineKeyboard(card.buttons) : undefined,
    });
    return { chatId: String(message.chat.id), messageId: message.message_id };
  }

  async editCard(ref: MessageRef, card: AlayaCard): Promise<void> {
    if (ref.messageId === 0 || this.notificationDryRun("editMessageText")) return;
    await this.telegramRequest("editMessageText", {
      chat_id: ref.chatId,
      message_id: ref.messageId,
      text: this.renderCardText(card),
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: card.buttons ? this.buildInlineKeyboard(card.buttons) : { inline_keyboard: [] },
    });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    if (!callbackId || this.notificationDryRun("answerCallbackQuery")) return;
    await this.telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    if (this.notificationDryRun("sendChatAction")) return;
    await this.telegramRequest("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  }

  onCallbackQuery(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.polling || this.notificationDryRun("getUpdates")) return;
    this.polling = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
  }

  private isAllowedChat(chatId: string | number): boolean {
    return String(chatId) === String(this.defaultChatId);
  }

  private notificationDryRun(method: string): boolean {
    const endpoint = telegramHostCheckUrl(method);
    const decision = checkCapability({
      actor: "telegram_adapter",
      capability: "external_notification",
      target: `telegram.${method}`,
      payload: {
        provider: "telegram",
        host: TELEGRAM_API_HOST,
        defaultChatId: this.defaultChatId,
      },
    });
    if (decision.dryRun) return true;
    if (!decision.allowed) throw new CapabilityDeniedError(decision);
    assertTelegramHostAllowlisted(endpoint);
    this.assertTelegramNetwork(method);
    return false;
  }

  private assertTelegramNetwork(method: string): void {
    assertNetworkAllowed(telegramHostCheckUrl(method), {
      actor: "telegram_adapter",
      payload: { provider: "telegram", host: TELEGRAM_API_HOST, method },
    });
  }

  private async telegramRequest<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const attempts = telegramRequestAttempts();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`https://${TELEGRAM_API_HOST}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(async () => ({
          ok: false,
          description: await response.text().catch(() => ""),
        })) as TelegramResponse<T>;
        if (response.ok && payload.ok) return payload.result as T;
        const message = `Telegram ${method} failed: ${response.status} ${payload.description ?? ""}`.trim();
        const error = new Error(message);
        if (!isRetryableTelegramStatus(response.status)) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /^Telegram .* failed: \d+/.test(error.message)) {
          const status = Number(error.message.match(/ failed: (\d+)/)?.[1]);
          if (Number.isFinite(status) && !isRetryableTelegramStatus(status)) throw error;
        }
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, telegramRetryBaseMs() * attempt));
      }
    }
    const suffix = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Telegram ${method} failed after ${attempts} attempt(s): ${suffix}`);
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        this.assertTelegramNetwork("getUpdates");
        const updates = await this.telegramRequest<TelegramUpdate[]>("getUpdates", {
          offset: this.offset || undefined,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          writeOffset(this.offset);
          await this.handleUpdate(update);
        }
      } catch (error) {
        console.error("[Telegram] polling failed:", error instanceof Error ? error.message : String(error));
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const query = update.callback_query;
      if (!query.data || !query.message) return;
      if (!this.isAllowedChat(query.message.chat.id)) return;
      for (const handler of this.callbackHandlers) {
        await handler(query.id, query.data, {
          chatId: String(query.message.chat.id),
          messageId: query.message.message_id,
          userId: query.from?.id == null ? undefined : String(query.from.id),
        });
      }
      return;
    }

    const text = update.message?.text?.trim();
    const chatId = update.message?.chat.id;
    if (!text || chatId == null) return;
    if (!this.isAllowedChat(chatId)) return;
    const userId = update.message?.from?.id == null ? undefined : String(update.message.from.id);
    if (text.startsWith("/status")) {
      await this.dispatchCommand("cmd:/status", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/gates")) {
      await this.dispatchCommand("cmd:/gates", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/review")) {
      await this.dispatchCommand("cmd:/review", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/window")) {
      await this.dispatchCommand("cmd:/window", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/pause")) {
      await this.dispatchCommand("cmd:/pause", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/resume")) {
      await this.dispatchCommand("cmd:/resume", String(chatId), update.message?.message_id ?? 0, userId);
    } else if (text.startsWith("/help")) {
      await this.sendText(String(chatId), "可用命令：\\/status 查看飞轮状态，\\/gates 列出待处理闸门，\\/review 开始审批，\\/window 查看窗口，\\/pause 暂停催审，\\/resume 恢复。");
    }
  }

  private async dispatchCommand(data: string, chatId: string, messageId: number, userId?: string): Promise<void> {
    for (const handler of this.callbackHandlers) {
      await handler("", data, { chatId, messageId, userId });
    }
  }

  private renderCardText(card: AlayaCard): string {
    const lines: string[] = [];
    if (card.title) lines.push(`*${card.title.text}*`, "");
    lines.push(card.body);
    if (card.footer) lines.push("", card.footer);
    return lines.join("\n");
  }

  private buildInlineKeyboard(buttons: CardButton[][]) {
    return {
      inline_keyboard: buttons.map((row) => row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      }))),
    };
  }
}
