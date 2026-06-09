#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

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

function log(fd, message) {
  writeSync(fd, `${new Date().toISOString()} ${message}\n`);
}

function writeStatus(statusPath, data) {
  writeFileSync(statusPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...data }, null, 2));
}

async function requestJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function listGateItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.gates)) return response.gates;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

const args = parseArgs(process.argv.slice(2));
const projectId = args["project-id"];
if (!projectId) throw new Error("--project-id is required");

const baseUrl = (args["base-url"] ?? "http://127.0.0.1:5300").replace(/\/+$/, "");
const logDir = args["log-dir"] ?? "validation-logs/health-signal-36h_live";
const timeoutSeconds = Math.max(1, Number(args["timeout-seconds"] ?? 1800));
const childTimeoutSeconds = Math.max(1, Number(args["child-timeout-seconds"] ?? 900));
const pollSeconds = Math.max(1, Number(args["poll-seconds"] ?? 5));
const continuous = args.continuous === "true";
const localProxyFallback = args["local-proxy-fallback"] ?? "true";
const localProxyDelaySeconds = Math.max(0, Number(args["local-proxy-delay-seconds"] ?? 5));
const runDir = resolve(ROOT, logDir);
const stateDir = resolve(runDir, "telegram-live-human-gate");
const statusPath = resolve(stateDir, "telegram_live_gate_status.json");
mkdirSync(stateDir, { recursive: true });

async function readPendingGateState() {
  const gates = await requestJson(`${baseUrl}/api/human-gates?projectId=${encodeURIComponent(projectId)}&status=pending`);
  const pendingGates = listGateItems(gates).filter((gate) => gate.status === "pending");
  const pendingMeaningGates = pendingGates.filter((gate) => gate.type === "meaning" && gate.blocking === 0);
  const pendingRiskGates = pendingGates.filter((gate) => gate.type === "risk");
  const pendingBlockingGates = pendingGates.filter((gate) => gate.blocking);
  const pendingActionableGates = pendingGates.filter((gate) => ["meaning", "direction", "risk"].includes(gate.type));
  return {
    pendingGates,
    pendingMeaningGates,
    pendingRiskGates,
    pendingBlockingGates,
    pendingActionableGates,
  };
}

const fd = openSync(resolve(stateDir, "watcher.out"), "a");
try {
  const childFailureByGate = new Map();
  log(fd, `watcher_restart project=${projectId} timeout=${timeoutSeconds} continuous=${continuous}`);
  writeStatus(statusPath, {
    status: "watching",
    projectId,
    baseUrl,
    runDir,
    stateDir,
    timeoutSeconds,
    childTimeoutSeconds,
    pollSeconds,
    continuous,
    statusPath,
    callbackOwner: "app",
    localProxyFallback,
    localProxyDelaySeconds,
  });
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const {
        pendingGates,
        pendingMeaningGates: pending,
        pendingRiskGates,
        pendingBlockingGates,
        pendingActionableGates,
      } = await readPendingGateState();
      if (pendingActionableGates.length > 0) {
        const selectedGate =
          pending.at(-1) ??
          pendingRiskGates.at(-1) ??
          pendingBlockingGates.at(-1) ??
          pendingActionableGates.at(-1) ??
          null;
        const childFailedAt = selectedGate ? childFailureByGate.get(selectedGate.id) : null;
        if (
          continuous &&
          selectedGate &&
          childFailedAt &&
          Date.now() - childFailedAt < childTimeoutSeconds * 1000
        ) {
          writeStatus(statusPath, {
            status: "pending_gate_after_child_failure",
            projectId,
            baseUrl,
            pendingMeaningGateCount: pending.length,
            pendingHumanGateCount: pendingGates.length,
            pendingRiskGateCount: pendingRiskGates.length,
            pendingBlockingGateCount: pendingBlockingGates.length,
            pendingActionableGateCount: pendingActionableGates.length,
            gateId: selectedGate.id,
            gateTitle: selectedGate.title,
            gateType: selectedGate.type,
            gateStatus: selectedGate.status,
            lastChildFailedAt: new Date(childFailedAt).toISOString(),
            callbackOwner: "app",
            statusPath,
            localProxyFallback,
            localProxyDelaySeconds,
          });
          await new Promise((resolveTimer) => setTimeout(resolveTimer, pollSeconds * 1000));
          continue;
        }
        log(fd, `pending_actionable_gate_count=${pendingActionableGates.length}`);
        for (const gate of pendingActionableGates) {
          log(fd, `${gate.id}\t${gate.type}\t${gate.blocking}\t${gate.title}\t${gate.status}`);
        }
        writeStatus(statusPath, {
          status: "pending_gate_found",
          projectId,
          baseUrl,
          pendingMeaningGateCount: pending.length,
          gateId: selectedGate?.id ?? null,
          gateTitle: selectedGate?.title ?? null,
          gateType: selectedGate?.type ?? null,
          gateStatus: selectedGate?.status ?? null,
          pendingHumanGateCount: pendingGates.length,
          pendingRiskGateCount: pendingRiskGates.length,
          pendingBlockingGateCount: pendingBlockingGates.length,
          pendingActionableGateCount: pendingActionableGates.length,
          callbackOwner: "app",
          statusPath,
          localProxyFallback,
          localProxyDelaySeconds,
        });
        const result = spawnSync(process.execPath, [
          "scripts/telegram-approve-pending-meaning-gate.mjs",
          `--log-dir=${logDir}`,
          `--project-id=${projectId}`,
          `--base-url=${baseUrl}`,
          `--gate-id=${selectedGate.id}`,
          "--gate-scope=any",
          `--timeout-seconds=${childTimeoutSeconds}`,
          "--callback-owner=app",
          `--local-proxy-fallback=${localProxyFallback}`,
          `--local-proxy-delay-seconds=${localProxyDelaySeconds}`,
        ], {
          cwd: ROOT,
          stdio: ["ignore", fd, fd],
          env: process.env,
        });
        log(fd, `watcher_exit code=${result.status ?? 1}`);
        if ((result.status ?? 1) !== 0) {
          if (continuous) {
            if (selectedGate) childFailureByGate.set(selectedGate.id, Date.now());
            writeStatus(statusPath, {
              status: "child_failed_continue_watching",
              projectId,
              baseUrl,
              exitCode: result.status ?? 1,
              pendingMeaningGateCount: pending.length,
              pendingHumanGateCount: pendingGates.length,
              pendingRiskGateCount: pendingRiskGates.length,
              pendingBlockingGateCount: pendingBlockingGates.length,
              pendingActionableGateCount: pendingActionableGates.length,
              gateId: selectedGate?.id ?? null,
              gateTitle: selectedGate?.title ?? null,
              gateType: selectedGate?.type ?? null,
              callbackOwner: "app",
              statusPath,
              localProxyFallback,
              localProxyDelaySeconds,
            });
            await new Promise((resolveTimer) => setTimeout(resolveTimer, pollSeconds * 1000));
            continue;
          }
          writeStatus(statusPath, {
            status: "child_failed",
            projectId,
            baseUrl,
            exitCode: result.status ?? 1,
            pendingMeaningGateCount: pending.length,
            pendingHumanGateCount: pendingGates.length,
            pendingRiskGateCount: pendingRiskGates.length,
            pendingBlockingGateCount: pendingBlockingGates.length,
            pendingActionableGateCount: pendingActionableGates.length,
            gateId: selectedGate?.id ?? null,
            gateTitle: selectedGate?.title ?? null,
            gateType: selectedGate?.type ?? null,
            callbackOwner: "app",
            statusPath,
            localProxyFallback,
            localProxyDelaySeconds,
          });
          process.exit(result.status ?? 1);
        }
        if (selectedGate) childFailureByGate.delete(selectedGate.id);
        if (!continuous) process.exit(0);
        log(fd, "watcher_continue_after_resolved_gate");
        const freshState = await readPendingGateState().catch(() => ({
          pendingGates,
          pendingMeaningGates: pending,
          pendingRiskGates,
          pendingBlockingGates,
          pendingActionableGates,
        }));
        const newestPending = freshState.pendingGates.at(-1) ?? null;
        writeStatus(statusPath, {
          status: freshState.pendingGates.length > 0 ? "resolved_continue_watching_pending_gate" : "resolved_continue_watching",
          projectId,
          baseUrl,
          pendingMeaningGateCount: freshState.pendingMeaningGates.length,
          pendingHumanGateCount: freshState.pendingGates.length,
          pendingRiskGateCount: freshState.pendingRiskGates.length,
          pendingBlockingGateCount: freshState.pendingBlockingGates.length,
          pendingActionableGateCount: freshState.pendingActionableGates.length,
          gateId: newestPending?.id ?? null,
          gateTitle: newestPending?.title ?? null,
          gateType: newestPending?.type ?? null,
          gateStatus: newestPending?.status ?? null,
          exitCode: result.status ?? 0,
          continuous,
          callbackOwner: "app",
          statusPath,
          localProxyFallback,
          localProxyDelaySeconds,
        });
        await new Promise((resolveTimer) => setTimeout(resolveTimer, pollSeconds * 1000));
        continue;
      }
      if (continuous) {
        const newestPending = pendingGates.at(-1) ?? null;
        writeStatus(statusPath, {
          status: pendingGates.length > 0 ? "pending_non_meaning_gate" : "no_pending_gate",
          projectId,
          baseUrl,
          pendingMeaningGateCount: 0,
          pendingHumanGateCount: pendingGates.length,
          pendingRiskGateCount: pendingRiskGates.length,
          pendingBlockingGateCount: pendingBlockingGates.length,
          pendingActionableGateCount: pendingActionableGates.length,
          gateId: newestPending?.id ?? null,
          gateTitle: newestPending?.title ?? null,
          gateType: newestPending?.type ?? null,
          gateStatus: newestPending?.status ?? null,
          continuous,
          statusPath,
          callbackOwner: "app",
          localProxyFallback,
          localProxyDelaySeconds,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(fd, `watcher_poll_failed ${message}`);
      writeStatus(statusPath, {
        status: "poll_failed",
        projectId,
        baseUrl,
        error: message,
        statusPath,
        callbackOwner: "app",
        localProxyFallback,
        localProxyDelaySeconds,
      });
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, pollSeconds * 1000));
  }
  log(fd, "watcher_timeout_no_pending_gate");
  writeStatus(statusPath, {
    status: "no_pending_gate",
    projectId,
    baseUrl,
    pendingMeaningGateCount: 0,
    pendingHumanGateCount: 0,
    pendingRiskGateCount: 0,
    pendingBlockingGateCount: 0,
    pendingActionableGateCount: 0,
    continuous,
    statusPath,
    callbackOwner: "app",
    localProxyFallback,
    localProxyDelaySeconds,
  });
  process.exit(continuous ? 0 : 2);
} finally {
  closeSync(fd);
}
