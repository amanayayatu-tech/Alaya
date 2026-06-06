import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import type { RiskLevel } from "@shared/core/types.js";
import { boolEnv, capabilityEnvName, runModeFromEnv, type RunMode } from "../config/env";
import { storage, now } from "../storage";
import { redactSensitiveData } from "./redact";

export type CapabilityName =
  | "filesystem_write"
  | "shell_execution"
  | "github_write"
  | "database_migration"
  | "network_unknown"
  | "llm_call"
  | "knowledge_write"
  | "scheduler_loop"
  | "external_notification";

export interface CapabilityDecision {
  capability: CapabilityName;
  mode: RunMode;
  allowed: boolean;
  dryRun: boolean;
  reason: string;
  envName: string;
}

export interface CapabilityCheckInput {
  actor: string;
  capability: CapabilityName;
  target?: string;
  payload?: Record<string, unknown>;
  projectId?: string;
  cycleId?: string | null;
  approvalId?: string | null;
}

export class CapabilityDeniedError extends Error {
  readonly decision: CapabilityDecision;

  constructor(decision: CapabilityDecision) {
    super(`Capability ${decision.capability} denied in ${decision.mode} mode: ${decision.reason}`);
    this.name = "CapabilityDeniedError";
    this.decision = decision;
  }
}

const SHADOW_DRY_RUN = new Set<CapabilityName>([
  "filesystem_write",
  "github_write",
  "knowledge_write",
  "scheduler_loop",
  "external_notification",
]);

const DEV_ALLOWED = new Set<CapabilityName>([
  "filesystem_write",
  "database_migration",
  "network_unknown",
  "llm_call",
  "knowledge_write",
  "scheduler_loop",
]);

const TEST_ALLOWED = new Set<CapabilityName>([
  "filesystem_write",
  "database_migration",
  "network_unknown",
  "llm_call",
  "knowledge_write",
  "scheduler_loop",
]);

const DEFAULT_ALLOWED_HOSTS = new Set([
  "api.github.com",
  "api.openai.com",
  "api.minimax.io",
  "api.minimaxi.com",
]);

function parseAllowedHosts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const host of (env.ALAYA_ALLOWED_NETWORK_HOSTS ?? "").split(",")) {
    const clean = host.trim().toLowerCase();
    if (!clean) continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) {
      throw new Error(`Invalid ALAYA_ALLOWED_NETWORK_HOSTS entry: ${clean}`);
    }
    hosts.add(clean);
  }
  return Object.freeze(hosts);
}

const CONFIGURED_ALLOWED_HOSTS = parseAllowedHosts();

function inputHash(value: unknown): string {
  const text = JSON.stringify(redactSensitiveData(value) ?? {});
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function riskLevelFor(capability: CapabilityName): RiskLevel {
  if (capability === "shell_execution" || capability === "database_migration") return "destructive";
  if (capability === "github_write" || capability === "external_notification" || capability === "network_unknown") return "external_write";
  if (capability === "llm_call") return "financial";
  if (capability === "knowledge_write") return "local_write";
  return "local_write";
}

function explicitDecision(value: string | undefined): "allow" | "deny" | "dry_run" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "dry_run" || normalized === "dry-run" || normalized === "audit") return "dry_run";
  const parsed = boolEnv(value);
  if (parsed === true) return "allow";
  if (parsed === false) return "deny";
  return undefined;
}

export function evaluateCapability(
  capability: CapabilityName,
  env: NodeJS.ProcessEnv = process.env,
): CapabilityDecision {
  const mode = runModeFromEnv(env);
  const envName = capabilityEnvName(capability);
  const explicit = explicitDecision(env[envName]);
  if (explicit === "allow") return { capability, mode, allowed: true, dryRun: false, reason: `${envName}=true`, envName };
  if (explicit === "deny") return { capability, mode, allowed: false, dryRun: false, reason: `${envName}=false`, envName };
  if (explicit === "dry_run") return { capability, mode, allowed: false, dryRun: true, reason: `${envName}=dry_run`, envName };

  if (mode === "test") {
    return {
      capability,
      mode,
      allowed: TEST_ALLOWED.has(capability),
      dryRun: false,
      reason: TEST_ALLOWED.has(capability) ? "test default allow" : "test default deny",
      envName,
    };
  }
  if (mode === "development") {
    return {
      capability,
      mode,
      allowed: DEV_ALLOWED.has(capability),
      dryRun: false,
      reason: DEV_ALLOWED.has(capability) ? "development default allow" : "development default deny",
      envName,
    };
  }
  if (mode === "shadow" && SHADOW_DRY_RUN.has(capability)) {
    return { capability, mode, allowed: false, dryRun: true, reason: "shadow default dry-run", envName };
  }
  return { capability, mode, allowed: false, dryRun: false, reason: "long-run default deny", envName };
}

export function auditCapabilityDecision(input: CapabilityCheckInput, decision: CapabilityDecision) {
  const payload = redactSensitiveData(input.payload ?? {});
  const timestamp = now();
  const ledgerPayload = {
    actor: input.actor,
    mode: decision.mode,
    capability: input.capability,
    target: input.target ?? "",
    inputHash: inputHash(payload),
    result: decision.allowed ? "allowed" : decision.dryRun ? "dry_run" : "denied",
    dryRun: decision.dryRun,
    reason: decision.reason,
    approvalId: input.approvalId ?? null,
    timestamp,
    input: payload,
  };
  const idempotencyKey = makeIdempotencyKey({
    projectId: input.projectId ?? "system",
    cycleId: input.cycleId ?? null,
    actionType: `capability.${input.capability}`,
    target: input.target,
    payload: ledgerPayload,
  });
  return storage.upsertActionLedger({
    id: `cap_${inputHash({ idempotencyKey }).slice(0, 8)}`,
    projectId: input.projectId ?? "system",
    cycleId: input.cycleId ?? null,
    actionType: `capability.${input.capability}`,
    target: input.target ?? "",
    riskLevel: riskLevelFor(input.capability),
    requiresApproval: 1,
    approvalGateId: input.approvalId ?? null,
    idempotencyKey,
    status: decision.allowed ? "approved" : decision.dryRun ? "dry_run" : "blocked",
    rollbackPlan: null,
    auditSummary: JSON.stringify({
      actor: input.actor,
      mode: decision.mode,
      capability: input.capability,
      result: ledgerPayload.result,
      reason: decision.reason,
    }),
    payload: JSON.stringify(ledgerPayload),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function checkCapability(input: CapabilityCheckInput): CapabilityDecision {
  const decision = evaluateCapability(input.capability);
  auditCapabilityDecision(input, decision);
  return decision;
}

export function requireCapability(input: CapabilityCheckInput): CapabilityDecision {
  const decision = checkCapability(input);
  if (!decision.allowed && !decision.dryRun) throw new CapabilityDeniedError(decision);
  return decision;
}

function isLocalHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
}

export function assertNetworkAllowed(url: string, context: Omit<CapabilityCheckInput, "capability" | "target"> = { actor: "network" }): void {
  const parsed = new URL(url);
  const mode = runModeFromEnv();
  const hostname = parsed.hostname.toLowerCase();
  if ((mode === "development" || mode === "test") && isLocalHost(hostname)) return;
  if (CONFIGURED_ALLOWED_HOSTS.has(hostname)) return;
  const decision = requireCapability({
    ...context,
    capability: "network_unknown",
    target: hostname,
    payload: { url: `${parsed.protocol}//${parsed.host}${parsed.pathname}` },
  });
  if (decision.dryRun) throw new CapabilityDeniedError(decision);
}
