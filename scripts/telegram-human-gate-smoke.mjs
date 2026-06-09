import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "..", "..");

function reexecWithTsxIfNeeded() {
  if (process.env.ALAYA_TSX_REEXEC === "1") return;
  if (process.execArgv.some((arg) => arg.includes("tsx"))) return;
  const loader = join(ROOT, "alaya-app", "node_modules", "tsx", "dist", "esm", "index.mjs");
  if (!existsSync(loader)) return;
  const result = spawnSync(process.execPath, ["--import", loader, SELF, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: join(ROOT, "alaya-app"),
    env: { ...process.env, ALAYA_TSX_REEXEC: "1" },
  });
  process.exit(result.status ?? 1);
}

reexecWithTsxIfNeeded();

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, rawValue] = arg.slice(2).split("=");
    out[rawKey] = rawValue ?? "true";
  }
  return out;
}

function loadDotenv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

async function seedTelegramOffset(token, stateDir) {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeout: 0, allowed_updates: ["message", "callback_query"] }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram getUpdates failed before smoke: ${response.status} ${payload.description ?? ""}`.trim());
  }
  const updates = Array.isArray(payload.result) ? payload.result : [];
  const offset = updates.length > 0 ? Math.max(...updates.map((item) => Number(item.update_id) || 0)) + 1 : 0;
  writeFileSync(join(stateDir, "telegram-update-offset.json"), JSON.stringify({ offset }, null, 2));
  return { skippedUpdateCount: updates.length, offset };
}

function writeStatus(file, data) {
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...data }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const logDir = resolve(ROOT, args["log-dir"] ?? join("validation-logs", `telegram-human-gate-smoke_${timestampForPath()}`));
const timeoutSeconds = Number(args["timeout-seconds"] ?? 180);
mkdirSync(logDir, { recursive: true });

loadDotenv(join(ROOT, ".env"));
loadDotenv(join(ROOT, "alaya-app", ".env"));

const token = process.env.ALAYA_TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.ALAYA_TELEGRAM_CHAT_ID?.trim();
if (!token || !chatId) {
  throw new Error("ALAYA_TELEGRAM_BOT_TOKEN and ALAYA_TELEGRAM_CHAT_ID are required for Telegram smoke.");
}

process.env.ALAYA_DB_PATH = join(logDir, "telegram-smoke.sqlite");
process.env.ALAYA_STATE_DIR = logDir;
process.env.ALAYA_MODE = "development";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_CAP_KNOWLEDGE_WRITE = "true";
process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
process.env.ALAYA_NOTIFICATION_PROVIDER = "telegram";
process.env.ALAYA_ALLOWED_NETWORK_HOSTS = process.env.ALAYA_ALLOWED_NETWORK_HOSTS?.includes("api.telegram.org")
  ? process.env.ALAYA_ALLOWED_NETWORK_HOSTS
  : `${process.env.ALAYA_ALLOWED_NETWORK_HOSTS ?? ""},api.telegram.org`;
process.env.ALAYA_BASE_URL = process.env.ALAYA_BASE_URL || "http://127.0.0.1:5998";

const statusPath = join(logDir, "telegram_smoke_status.json");
const startedAt = new Date();
writeStatus(statusPath, { status: "starting", logDir, timeoutSeconds });

const offsetSeed = await seedTelegramOffset(token, logDir);

const { storage, now } = await import("../alaya-app/server/storage.ts");
const { TelegramAdapter } = await import("../alaya-app/server/notifications/telegram.ts");
const { NotificationBus } = await import("../alaya-app/server/notifications/bus.ts");
const { CallbackRouter } = await import("../alaya-app/server/notifications/router.ts");
const { HumanGateService } = await import("../alaya-app/server/humanGateService.ts");
const { recordNotificationEmitFailure } = await import("../alaya-app/server/scheduler.ts");

const suffix = Date.now().toString(36);
const projectId = `proj_tg_smoke_${suffix}`;
const cycleId = `cycle_tg_smoke_${suffix}`;
const gateId = `gate_meaning_tg_smoke_${suffix}`;

storage.createProject({
  id: projectId,
  name: "Telegram Human Gate Smoke",
  direction: "Verify real Telegram callback can approve a non-blocking meaning gate.",
  targetUser: "Alaya validation operator",
  redlines: "[]",
  weeklyHumanMinutes: 150,
  weeklyLlmBudgetCents: 100,
  firstClaimMetric: "telegram_callback_success",
  firstClaimOperator: ">=",
  firstClaimTarget: 1,
  seedIdentity: "",
  worldModel: "",
  currentCycleIdx: 1,
  version: 1,
});
storage.createCycle({
  id: cycleId,
  projectId,
  idx: 1,
  goal: "Telegram Human Gate callback smoke",
  status: "planning",
  eCycle: null,
  worstClaimError: null,
  reasoning: "",
  version: 1,
});
storage.createGate({
  id: gateId,
  cycleId,
  type: "meaning",
  blocking: 0,
  title: "Telegram smoke meaning gate",
  payload: JSON.stringify({
    source: "telegram_smoke",
    externalId: gateId,
    topicKey: "telegram_human_gate",
    category: "unclear_signal",
    sentiment: "neutral",
    summary: "Approve this card from Telegram to prove Human Gate callback handling.",
    userQuote: "Telegram Human Gate smoke; approve to simulate a human decision.",
    createdAt: now(),
  }),
  status: "pending",
  estimatedMinutes: 1,
  decision: null,
  version: 1,
});

const adapter = new TelegramAdapter(token, chatId);
const gateService = new HumanGateService(storage);
const router = new CallbackRouter(adapter, storage, gateService, process.env.ALAYA_BASE_URL);
adapter.onCallbackQuery((callbackId, data, ref) => router.route(callbackId, data, ref));
const bus = new NotificationBus(recordNotificationEmitFailure).addAdapter(adapter, [chatId]);

let stopping = false;
async function stopBus() {
  if (stopping) return;
  stopping = true;
  await bus.stop().catch(() => {});
}

process.on("SIGINT", () => {
  void stopBus().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void stopBus().finally(() => process.exit(143));
});

await bus.start();
await bus.emit({
  type: "gate_opened",
  projectId,
  title: "Telegram Human Gate Smoke",
  body: "Click Approve in Telegram. This should resolve the local meaning gate through CallbackRouter and HumanGateService.",
  gateId,
  gateType: "meaning",
  isBlocking: false,
  actionUrl: `${process.env.ALAYA_BASE_URL.replace(/\/+$/, "")}/#/human-gates?gate=${encodeURIComponent(gateId)}`,
});

writeStatus(statusPath, {
  status: "waiting_for_telegram_callback",
  startedAt: startedAt.toISOString(),
  projectId,
  cycleId,
  gateId,
  skippedUpdateCount: offsetSeed.skippedUpdateCount,
  offset: offsetSeed.offset,
  expectedTelegramButton: "✅ 批准",
});

const deadline = Date.now() + timeoutSeconds * 1000;
let finalGate = storage.getGate(gateId);
while (Date.now() < deadline) {
  finalGate = storage.getGate(gateId);
  writeStatus(statusPath, {
    status: finalGate?.status === "pending" ? "waiting_for_telegram_callback" : "resolved",
    startedAt: startedAt.toISOString(),
    projectId,
    cycleId,
    gateId,
    gateStatus: finalGate?.status ?? "missing",
    decision: finalGate?.decision ?? null,
    expectedTelegramButton: "✅ 批准",
  });
  if (finalGate && finalGate.status !== "pending") break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

finalGate = storage.getGate(gateId);
const decisions = storage.listDecisions(projectId);
const ledger = storage.listActionLedger(projectId);
const events = storage.listEvents().filter((event) => event.tableName === "human_gate_items" || event.tableName === "notifications");
const summary = {
  status: finalGate?.status === "approved" ? "passed" : "failed",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  projectId,
  cycleId,
  gateId,
  gateStatus: finalGate?.status ?? "missing",
  decision: finalGate?.decision ?? null,
  decisionCount: decisions.length,
  telegramLedgerRows: ledger.filter((row) => row.actionType.startsWith("human_gate.")).length,
  notificationFailureCount: events.filter((event) => event.tableName === "notifications").length,
  statusPath,
};
writeStatus(statusPath, summary);
await stopBus();
console.log(JSON.stringify(summary, null, 2));
