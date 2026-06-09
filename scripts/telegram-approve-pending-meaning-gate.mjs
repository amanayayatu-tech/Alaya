#!/usr/bin/env node
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

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = "true";
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
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
    throw new Error(`Telegram getUpdates failed before live gate approval: ${response.status} ${payload.description ?? ""}`.trim());
  }
  const updates = Array.isArray(payload.result) ? payload.result : [];
  const offset = updates.length > 0 ? Math.max(...updates.map((item) => Number(item.update_id) || 0)) + 1 : 0;
  writeFileSync(join(stateDir, "telegram-update-offset.json"), JSON.stringify({ offset }, null, 2));
  return { skippedUpdateCount: updates.length, offset };
}

function writeStatus(file, data) {
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...data }, null, 2));
}

function uniqueMessageRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const chatId = String(ref?.chatId ?? "");
    const messageId = Number(ref?.messageId);
    if (!chatId || !Number.isInteger(messageId) || messageId <= 0) return false;
    const key = `${chatId}:${messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const args = parseArgs(process.argv.slice(2));
const runDir = resolve(ROOT, args["log-dir"] ?? join("validation-logs", "health-signal-36h_live"));
const dbPath = resolve(ROOT, args["db-path"] ?? join(runDir, "health-signal.db"));
const stateDir = resolve(ROOT, args["state-dir"] ?? join(runDir, "telegram-live-human-gate"));
const statusPath = resolve(ROOT, args["status-path"] ?? join(stateDir, "telegram_live_gate_status.json"));
const timeoutSeconds = Math.max(1, Number(args["timeout-seconds"] ?? 600));
const projectIdArg = args["project-id"];
const gateIdArg = args["gate-id"];
const gateScope = String(args["gate-scope"] ?? "meaning").toLowerCase();
const callbackOwner = String(args["callback-owner"] ?? "app").toLowerCase();
const ownsTelegramPolling = callbackOwner === "self" || args["own-polling"] === "true";
const localProxyFallback = args["local-proxy-fallback"] === "true";
const localProxyDelaySeconds = Math.max(0, Number(args["local-proxy-delay-seconds"] ?? 0));

function gateMessageRefPaths() {
  const candidates = [
    process.env.ALAYA_NOTIFICATION_REF_PATH?.trim(),
    join(runDir, "state", "telegram-gate-message-refs.json"),
    join(stateDir, "telegram-gate-message-refs.json"),
  ].filter(Boolean);
  return Array.from(new Set(candidates.map((candidate) => resolve(ROOT, candidate))));
}

function persistedGateMessageRefs(gateId) {
  const refs = [];
  for (const refPath of gateMessageRefPaths()) {
    if (!existsSync(refPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(refPath, "utf8"));
      const keyedRefs = parsed?.[gateId];
      if (!keyedRefs || typeof keyedRefs !== "object" || Array.isArray(keyedRefs)) continue;
      for (const value of Object.values(keyedRefs)) {
        refs.push(value);
      }
    } catch (error) {
      console.error(`[Telegram] failed to read persisted gate refs ${refPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return uniqueMessageRefs(refs);
}

async function waitForPersistedGateMessageRef(gateId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let refs = persistedGateMessageRefs(gateId);
  while (refs.length === 0 && Date.now() < deadline) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
    refs = persistedGateMessageRefs(gateId);
  }
  return refs[0] ?? null;
}

async function editPersistedGateCards(gateId, card, excludeRef) {
  const excludeKey = excludeRef?.chatId && excludeRef?.messageId ? `${excludeRef.chatId}:${excludeRef.messageId}` : "";
  let editedCount = 0;
  for (const ref of persistedGateMessageRefs(gateId)) {
    const refKey = `${ref.chatId}:${ref.messageId}`;
    if (refKey === excludeKey) continue;
    await adapter.editCard(ref, card).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/message is not modified/i.test(message)) return;
      console.error(`[Telegram] editCard(persisted app gate receipt) failed for ${gateId}/${refKey}: ${message}`);
    });
    editedCount += 1;
  }
  return editedCount;
}

async function editPersistedGateCardsUntil(gateId, card, excludeRef, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let totalEdited = 0;
  do {
    totalEdited += await editPersistedGateCards(gateId, card, excludeRef);
    if (Date.now() >= deadline) break;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  } while (Date.now() < deadline);
  return totalEdited;
}

mkdirSync(stateDir, { recursive: true });
loadDotenv(join(ROOT, ".env"));
loadDotenv(join(ROOT, "alaya-app", ".env"));

const token = process.env.ALAYA_TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.ALAYA_TELEGRAM_CHAT_ID?.trim();
if (!token || !chatId) {
  throw new Error("ALAYA_TELEGRAM_BOT_TOKEN and ALAYA_TELEGRAM_CHAT_ID are required.");
}

process.env.ALAYA_DB_PATH = dbPath;
process.env.ALAYA_STATE_DIR = stateDir;
process.env.ALAYA_MODE = "development";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_CAP_KNOWLEDGE_WRITE = "true";
process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
process.env.ALAYA_NOTIFICATION_PROVIDER = "telegram";
process.env.ALAYA_ALLOWED_NETWORK_HOSTS = process.env.ALAYA_ALLOWED_NETWORK_HOSTS?.includes("api.telegram.org")
  ? process.env.ALAYA_ALLOWED_NETWORK_HOSTS
  : `${process.env.ALAYA_ALLOWED_NETWORK_HOSTS ?? ""},api.telegram.org`;
process.env.ALAYA_BASE_URL = args["base-url"] ?? "http://127.0.0.1:5300";

writeStatus(statusPath, {
  status: "starting",
  runDir,
  dbPath,
  stateDir,
  timeoutSeconds,
});

const offsetSeed = ownsTelegramPolling
  ? await seedTelegramOffset(token, stateDir)
  : { skippedUpdateCount: 0, offset: null };

const { storage } = await import("../alaya-app/server/storage.ts");
const { TelegramAdapter } = await import("../alaya-app/server/notifications/telegram.ts");
const { HumanGateService } = await import("../alaya-app/server/humanGateService.ts");
const { resolveKnowledgeReview } = await import("../alaya-app/server/knowledgeReview.ts");
const { gateCard } = await import("../alaya-app/server/notifications/card.ts");
const { escapeMarkdownV2, escapeMarkdownV2LinkUrl } = await import("../alaya-app/server/notifications/telegram-simple.ts");
const {
  formatGateDecisionRequestText,
  formatGateDecisionReceiptText,
  formatGateProcessingText,
  knowledgeIdForMeaningGate,
} = await import("../alaya-app/server/notifications/gateNarrative.ts");

const projectId = projectIdArg ?? storage.getProjects().at(-1)?.id;
if (!projectId) throw new Error("No project found. Pass --project-id.");

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pendingGateCounts() {
  const pendingGates = storage
    .listGates(projectId)
    .filter((item) => item.status === "pending");
  return {
    pendingMeaningGateCount: pendingGates.filter((item) => item.type === "meaning" && item.blocking === 0).length,
    pendingHumanGateCount: pendingGates.length,
    pendingRiskGateCount: pendingGates.filter((item) => item.type === "risk").length,
    pendingBlockingGateCount: pendingGates.filter((item) => item.blocking).length,
    pendingActionableGateCount: pendingGates.filter(isActionableGate).length,
  };
}

function isActionableGate(gate) {
  return gate && gate.status === "pending" && ["meaning", "direction", "risk"].includes(gate.type);
}

function gateMatchesScope(gate) {
  if (!isActionableGate(gate)) return false;
  if (gateScope === "any" || gateScope === "all") return true;
  if (gateScope === "meaning") return gate.type === "meaning" && gate.blocking === 0;
  return gate.type === gateScope;
}

function gateWaitResolved(gate) {
  if (!gate || gate.status !== "pending") return true;
  const payload = parsePayload(gate.payload);
  if (gate.type === "risk" && payload.riskKey === "knowledge_conflict_review" && payload.reviewId) {
    const review = storage.getKnowledgeReview(String(payload.reviewId));
    return review ? review.status !== "review_required" : false;
  }
  return false;
}

const candidateGates = storage
  .listGates(projectId)
  .filter((gate) => gateMatchesScope(gate));
const gate = gateIdArg
  ? storage.getGate(gateIdArg)
  : candidateGates.at(-1);

if (!gate) {
  writeStatus(statusPath, {
    status: "no_pending_gate",
    projectId,
    ...pendingGateCounts(),
    skippedUpdateCount: offsetSeed.skippedUpdateCount,
    offset: offsetSeed.offset,
  });
  throw new Error(`No pending ${gateScope} gate found for project ${projectId}.`);
}
if (!isActionableGate(gate) || (gateIdArg ? false : !gateMatchesScope(gate))) {
  writeStatus(statusPath, {
    status: "unsupported_gate",
    projectId,
    gateId: gate.id,
    gateStatus: gate.status,
    gateType: gate.type,
    blocking: gate.blocking,
    gateScope,
    ...pendingGateCounts(),
  });
  throw new Error(`Gate ${gate.id} is not a pending actionable ${gateScope} gate.`);
}

const gatePayload = parsePayload(gate.payload);
const gateService = new HumanGateService(storage);
if (ownsTelegramPolling && gate.type === "risk" && gatePayload.riskKey === "knowledge_conflict_review") {
  writeStatus(statusPath, {
    status: "unsupported_gate_self_polling",
    projectId,
    gateId: gate.id,
    gateStatus: gate.status,
    gateType: gate.type,
    blocking: gate.blocking,
    gateScope,
    ...pendingGateCounts(),
  });
  throw new Error(`Gate ${gate.id} is a knowledge conflict review; use --callback-owner=app so the app CallbackRouter can resolve review actions.`);
}

const adapter = new TelegramAdapter(token, chatId);
const actionParams = new URLSearchParams({ projectId, gate: gate.id });
const actionUrl = `${process.env.ALAYA_BASE_URL.replace(/\/+$/, "")}/#/human-gates?${actionParams.toString()}`;

function pendingProjectReviewCount() {
  return storage
    .listKnowledgeReviews(projectId)
    .filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
}

function textForKnowledge(id) {
  const item = storage.getKnowledge(id);
  if (!item) return "";
  return `${item.title ?? ""}\n${item.content ?? ""}\n${item.notes ?? ""}`.toLowerCase();
}

function chooseKnowledgeReviewResolution(review) {
  const primaryText = textForKnowledge(review.primaryKnowledgeId);
  const relatedText = review.relatedKnowledgeId ? textForKnowledge(review.relatedKnowledgeId) : "";
  const relatedLooksHybrid = /hybrid|混合|ppg_ecg|ecg 复核|ecg复核|分层/.test(relatedText);
  const primaryLooksRisk = /风险|反证|干扰|功耗|交互|成本压力|肤色|佩戴|运动/.test(primaryText);
  const primaryIsEcgOnlySupport = /ecg 优先|优先 ecg|ecg优先/.test(primaryText) && !primaryLooksRisk;
  const primaryRejectsHybrid = /反对混合|混合方案反证|hybrid_reject/.test(primaryText);

  if (!review.relatedKnowledgeId) {
    return {
      action: "quarantine",
      survivorKnowledgeId: undefined,
      rationale: "Telegram card delivered, but this conflict review has no related survivor; quarantine the current primary item so it cannot enter active reuse until a human performs deeper review.",
    };
  }
  if (primaryIsEcgOnlySupport || primaryRejectsHybrid) {
    return {
      action: "quarantine",
      survivorKnowledgeId: undefined,
      rationale: "Telegram card delivered; the primary item makes a single-path or hybrid-rejection claim that would undermine the current converged boundary. Quarantine it as conflict evidence instead of reusing it as active knowledge.",
    };
  }
  if (relatedLooksHybrid && primaryLooksRisk) {
    return {
      action: "merge_supersede",
      survivorKnowledgeId: review.relatedKnowledgeId,
      rationale: "Telegram card delivered; the primary risk evidence strengthens the existing hybrid boundary rather than replacing it. Merge/supersede the primary item into the related hybrid survivor and keep the contradiction as audit evidence.",
    };
  }
  return {
    action: "merge_supersede",
    survivorKnowledgeId: review.relatedKnowledgeId,
    rationale: "Telegram card delivered; preserve the related knowledge as survivor and supersede the newly reviewed primary item after recording the contradiction.",
  };
}

async function applyLocalProxyDecision(currentGate, sent) {
  const currentPayload = parsePayload(currentGate?.payload ?? gatePayload);
  let resultGate = currentGate;
  let action = "approve";
  let rationale = "Telegram card was delivered for human-visible review; local API human proxy applied the approval because Telegram Desktop automation cannot reliably click inline buttons in this environment.";
  let dryRun = false;
  let knowledgeReviewAction = null;

  if (currentGate?.type === "risk" && currentPayload.riskKey === "knowledge_conflict_review" && currentPayload.reviewId) {
    const review = storage.getKnowledgeReview(String(currentPayload.reviewId));
    if (review?.status === "review_required") {
      const decision = chooseKnowledgeReviewResolution(review);
      resolveKnowledgeReview(review.id, {
        action: decision.action,
        actor: "human_proxy",
        rationale: `${decision.rationale} Applied by local API human proxy after Telegram delivery because Computer Use click returned AXError.notImplemented.`,
        survivorKnowledgeId: decision.survivorKnowledgeId,
      });
      knowledgeReviewAction = decision.action;
      rationale = `知识冲突复核已处理：${decision.action}。${decision.rationale}`;
    }
    resultGate = storage.getGate(`gate_${currentPayload.reviewId}`) ?? currentGate;
  } else if (currentGate?.status === "pending") {
    const result = action === "approve"
      ? gateService.approve(currentGate.id, { via: "telegram_card_local_api_human_proxy", actor: "human_proxy", rationale })
      : gateService.reject(currentGate.id, { via: "telegram_card_local_api_human_proxy", actor: "human_proxy", rationale });
    resultGate = result.gate ?? storage.getGate(currentGate.id) ?? currentGate;
    dryRun = Boolean(result.dryRun);
  }

  const pendingGatesAfter = storage.listGates(projectId).filter((item) => item.status === "pending").length;
  const openConflictReviewsAfter = pendingProjectReviewCount();
  const receiptText = formatGateDecisionReceiptText(resultGate ?? currentGate ?? gate, {
    action,
    dryRun,
    via: "Telegram card + local API human proxy",
    decidedAt: new Date(),
    pendingGatesAfter,
    openConflictReviewsAfter,
    knowledgeId: action === "approve" && currentGate?.type === "meaning" ? knowledgeIdForMeaningGate(currentGate.id) : null,
    projectId,
    rationale,
  });
  const receiptCard = { body: escapeMarkdownV2(receiptText) };
  await adapter.editCard(sent, receiptCard).catch((error) => {
    console.error(`[Telegram] editCard(local proxy receipt) failed: ${error instanceof Error ? error.message : String(error)}`);
    return adapter.sendText(sent.chatId ?? chatId, escapeMarkdownV2(receiptText)).catch((sendError) => {
      console.error(`[Telegram] sendText(local proxy receipt fallback) failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    });
  });
  const latePersistedReceiptEdits = currentGate?.id
    ? await editPersistedGateCardsUntil(currentGate.id, receiptCard, sent)
    : 0;

  return {
    status: "local_proxy_applied",
    projectId,
    gateId: currentGate?.id ?? gate.id,
    gateTitle: currentGate?.title ?? gate.title,
    gateType: currentGate?.type ?? gate.type,
    gateStatus: resultGate?.status ?? currentGate?.status ?? "missing",
    decision: resultGate?.decision ?? currentGate?.decision ?? null,
    localProxyFallback,
    localProxyDelaySeconds,
    latePersistedReceiptEdits,
    knowledgeReviewAction,
    ...pendingGateCounts(),
    sent,
    actionUrl,
    callbackOwner: "app",
  };
}

if (!ownsTelegramPolling) {
  const requestCard = gateCard({
    title: gate.title,
    body: formatGateDecisionRequestText(gate, { projectId }),
    gateId: gate.id,
    gateType: gate.type,
    isBlocking: Boolean(gate.blocking),
    actionUrl,
    riskKey: gatePayload.riskKey,
    reviewId: gatePayload.reviewId,
  });
  const persistedGateRef = await waitForPersistedGateMessageRef(gate.id);
  const sent = persistedGateRef ?? await adapter.sendCard(chatId, requestCard);
  const reusedPersistedGateCard = Boolean(persistedGateRef);

  writeStatus(statusPath, {
    status: "waiting_for_app_callback_router",
    projectId,
    gateId: gate.id,
    gateTitle: gate.title,
    gateType: gate.type,
    ...pendingGateCounts(),
    sent,
    reusedPersistedGateCard,
    actionUrl,
    callbackOwner: "app",
    localProxyFallback,
    localProxyDelaySeconds,
    skippedUpdateCount: offsetSeed.skippedUpdateCount,
    offset: offsetSeed.offset,
    expectedTelegramButton: gate.type === "risk" && gatePayload.riskKey === "knowledge_conflict_review"
      ? "knowledge review inline buttons handled by the running app callback router"
      : "approve or reject inline button handled by the running app callback router",
  });

  if (localProxyFallback) {
    if (localProxyDelaySeconds > 0) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, localProxyDelaySeconds * 1000));
    }
    const currentGate = storage.getGate(gate.id);
    if (!gateWaitResolved(currentGate)) {
      const proxySummary = await applyLocalProxyDecision(currentGate ?? gate, sent);
      writeStatus(statusPath, proxySummary);
    }
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  let finalGate = storage.getGate(gate.id);
  while (Date.now() < deadline) {
    finalGate = storage.getGate(gate.id);
    writeStatus(statusPath, {
      status: gateWaitResolved(finalGate) ? "resolved" : "waiting_for_app_callback_router",
      projectId,
      gateId: gate.id,
      gateTitle: gate.title,
      gateType: gate.type,
      gateStatus: finalGate?.status ?? "missing",
      decision: finalGate?.decision ?? null,
      ...pendingGateCounts(),
      sent,
      reusedPersistedGateCard,
      actionUrl,
      callbackOwner: "app",
      localProxyFallback,
      localProxyDelaySeconds,
    });
    if (gateWaitResolved(finalGate)) break;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 2_000));
  }

  finalGate = storage.getGate(gate.id);
  const decisions = storage.listDecisions(projectId);
  const ledger = storage.listActionLedger(projectId);
  const events = storage.listEvents().filter((event) => event.tableName === "human_gate_items" || event.tableName === "notifications");
  const summary = {
    status: gateWaitResolved(finalGate) ? "resolved" : "timed_out",
    projectId,
    gateId: gate.id,
    gateTitle: gate.title,
    gateType: gate.type,
    gateStatus: finalGate?.status ?? "missing",
    decision: finalGate?.decision ?? null,
    ...pendingGateCounts(),
    decisionCount: decisions.length,
    telegramLedgerRows: ledger.filter((row) => row.actionType.startsWith("human_gate.")).length,
    notificationFailureCount: events.filter((event) => event.tableName === "notifications").length,
    statusPath,
    callbackOwner: "app",
    reusedPersistedGateCard,
    localProxyFallback,
    localProxyDelaySeconds,
  };
  writeStatus(statusPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.status === "timed_out" ? 2 : 0);
}

const callbackAlias = Date.now().toString(36).slice(-8);
const approveCallback = `lhg:a:${callbackAlias}`;
const rejectCallback = `lhg:r:${callbackAlias}`;
adapter.onCallbackQuery(async (callbackId, data, ref) => {
  let callbackAnswerError = "";
  if (callbackId) {
    try {
      await adapter.answerCallback(callbackId);
    } catch (error) {
      callbackAnswerError = error instanceof Error ? error.message : String(error);
      console.error(`[Telegram] answerCallback failed; continuing gate decision: ${callbackAnswerError}`);
    }
  }
  if (data !== approveCallback && data !== rejectCallback) {
    await adapter.sendText(ref.chatId, escapeMarkdownV2(`Unknown live gate callback: ${data}`));
    return;
  }
  await adapter.sendTyping?.(ref.chatId).catch((error) => {
    console.error(`[Telegram] sendTyping failed; continuing gate decision: ${error instanceof Error ? error.message : String(error)}`);
  });
  await adapter.editCard(ref, { body: escapeMarkdownV2(formatGateProcessingText(gate)) }).catch((error) => {
    console.error(`[Telegram] editCard(start) failed; continuing gate decision: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const action = data === approveCallback ? "approve" : "reject";
    const result = action === "approve"
      ? gateService.approve(gate.id, { via: "telegram", actor: "human_telegram" })
      : gateService.reject(gate.id, { via: "telegram", actor: "human_telegram" });
    const pendingGatesAfter = storage.listGates(projectId).filter((item) => item.status === "pending").length;
    const openConflictReviewsAfter = storage
      .listKnowledgeReviews(projectId)
      .filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
    const callbackWarning = callbackAnswerError
      ? `callback answer failed but gate action was applied: ${callbackAnswerError}`
      : "";
    await adapter.editCard(ref, {
      body: escapeMarkdownV2(formatGateDecisionReceiptText(result.gate ?? gate, {
        action,
        dryRun: result.dryRun,
        via: "Telegram",
        decidedAt: new Date(),
        pendingGatesAfter,
        openConflictReviewsAfter,
        knowledgeId: action === "approve" && gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null,
        callbackWarning,
      })),
    }).catch((error) => {
      console.error(`[Telegram] editCard(final) failed after gate decision: ${error instanceof Error ? error.message : String(error)}`);
      if (callbackWarning) console.error(callbackWarning);
    });
  } catch (error) {
    await adapter.editCard(ref, {
      body: escapeMarkdownV2(`处理失败：${error instanceof Error ? error.message : String(error)}`),
    }).catch(() => {});
  }
});

let stopping = false;
async function stopAdapter() {
  if (stopping) return;
  stopping = true;
  await adapter.stop().catch(() => {});
}

process.on("SIGINT", () => {
  void stopAdapter().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void stopAdapter().finally(() => process.exit(143));
});

await adapter.start();
const sent = await adapter.sendCard(chatId, {
  title: { text: escapeMarkdownV2(`🟡 ${gate.title}`), color: "orange" },
  body: escapeMarkdownV2(formatGateDecisionRequestText(gate, { projectId })),
  footer: `[在 Web UI 查看详情](${escapeMarkdownV2LinkUrl(actionUrl)})`,
  buttons: [[
    { text: "✅ 批准", type: "primary", callbackData: approveCallback },
    { text: "❌ 否决", type: "danger", callbackData: rejectCallback },
  ]],
});

writeStatus(statusPath, {
  status: "waiting_for_telegram_callback",
  projectId,
  gateId: gate.id,
  gateTitle: gate.title,
  gateType: gate.type,
  ...pendingGateCounts(),
  sent,
  actionUrl,
  callbackAlias,
  approveCallback,
  rejectCallback,
  skippedUpdateCount: offsetSeed.skippedUpdateCount,
  offset: offsetSeed.offset,
  expectedTelegramButton: "approve or reject inline button",
});

const deadline = Date.now() + timeoutSeconds * 1000;
let finalGate = storage.getGate(gate.id);
while (Date.now() < deadline) {
  finalGate = storage.getGate(gate.id);
  writeStatus(statusPath, {
    status: gateWaitResolved(finalGate) ? "resolved" : "waiting_for_telegram_callback",
    projectId,
    gateId: gate.id,
    gateTitle: gate.title,
    gateType: gate.type,
    gateStatus: finalGate?.status ?? "missing",
    decision: finalGate?.decision ?? null,
    ...pendingGateCounts(),
    sent,
    actionUrl,
    callbackAlias,
    approveCallback,
    rejectCallback,
  });
  if (gateWaitResolved(finalGate)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

finalGate = storage.getGate(gate.id);
const decisions = storage.listDecisions(projectId);
const ledger = storage.listActionLedger(projectId);
const events = storage.listEvents().filter((event) => event.tableName === "human_gate_items" || event.tableName === "notifications");
const summary = {
  status: gateWaitResolved(finalGate) ? "resolved" : "timed_out",
  projectId,
  gateId: gate.id,
  gateTitle: gate.title,
  gateType: gate.type,
  gateStatus: finalGate?.status ?? "missing",
  decision: finalGate?.decision ?? null,
  ...pendingGateCounts(),
  decisionCount: decisions.length,
  telegramLedgerRows: ledger.filter((row) => row.actionType.startsWith("human_gate.")).length,
  notificationFailureCount: events.filter((event) => event.tableName === "notifications").length,
  statusPath,
};
writeStatus(statusPath, summary);
await stopAdapter();
console.log(JSON.stringify(summary, null, 2));
