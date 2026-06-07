import { assertNetworkAllowed, checkCapability } from "../security/capabilities";

export const TELEGRAM_API_HOST = "api.telegram.org";
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g;

export interface TelegramNotificationContext {
  actor?: string;
  projectId?: string;
  cycleId?: string | null;
  preEscapedMarkdownV2?: boolean;
}

export function escapeMarkdownV2(value: unknown): string {
  return String(value ?? "").replace(MARKDOWN_V2_SPECIAL_CHARS, (char) => `\\${char}`);
}

export function escapeMarkdownV2LinkUrl(value: string): string {
  return value.replace(/[\\)]/g, (char) => `\\${char}`);
}

function configuredAllowedHosts(): Set<string> {
  return new Set(
    (process.env.ALAYA_ALLOWED_NETWORK_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertTelegramHostAllowlisted(endpoint: string): void {
  const host = new URL(endpoint).hostname.toLowerCase();
  if (host !== TELEGRAM_API_HOST) {
    throw new Error(`Unexpected Telegram API host: ${host}`);
  }
  if (!configuredAllowedHosts().has(host)) {
    throw new Error(`${host} is not listed in ALAYA_ALLOWED_NETWORK_HOSTS`);
  }
}

export function assertValidTelegramToken(token: string): void {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Invalid Telegram bot token format");
  }
}

export async function sendTelegramText(
  token: string,
  chatId: string,
  text: string,
  context: TelegramNotificationContext = {},
): Promise<void> {
  assertValidTelegramToken(token);
  const endpoint = `https://${TELEGRAM_API_HOST}/bot${token}/sendMessage`;
  const decision = checkCapability({
    actor: context.actor ?? "scheduler",
    capability: "external_notification",
    target: "telegram.sendMessage",
    projectId: context.projectId,
    cycleId: context.cycleId ?? null,
    payload: {
      provider: "telegram",
      host: TELEGRAM_API_HOST,
      chatId,
      textLength: text.length,
    },
  });

  if (!decision.allowed) return;

  assertTelegramHostAllowlisted(endpoint);
  assertNetworkAllowed(endpoint, {
    actor: context.actor ?? "scheduler",
    projectId: context.projectId,
    cycleId: context.cycleId ?? null,
    payload: { provider: "telegram", host: TELEGRAM_API_HOST },
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: context.preEscapedMarkdownV2 ? text : escapeMarkdownV2(text),
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body.slice(0, 300)}`);
  }
}
