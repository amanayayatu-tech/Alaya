import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import type { RiskLevel } from "@shared/core/types.js";
import { recordActionProposal } from "./actionLedger";
import { runModeFromEnv } from "./config/env";
import { auditCapabilityDecision, evaluateCapability } from "./security/capabilities";
import { redactSensitiveData } from "./security/redact";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";
import { createDecisionBrief, withDecisionBriefPayload } from "./decisionBrief";

export interface BuilderPlanInput {
  projectId: string;
  cycleId?: string | null;
  goal: string;
  repoPath?: string;
  constraints?: string[];
  requestedFiles?: string[];
}

export interface BuilderChangePackage {
  projectId: string;
  cycleId?: string | null;
  goal: string;
  affectedFiles: string[];
  diff?: string;
  diffSummary: string;
  testPlan: string[];
  rollbackPlan: string[];
  riskLevel: RiskLevel;
  idempotencyKey: string;
  auditSummary: string;
  dryRun: boolean;
  adapter: string;
}

export interface ApplyChangePackageResult {
  status: "dry_run" | "blocked" | "approved";
  applied: false;
  reason: string;
  idempotencyKey: string;
  actionLedgerId: string;
  approvalGateId?: string | null;
}

export interface BuilderAdapter {
  planChange(input: BuilderPlanInput): Promise<BuilderChangePackage>;
  generateChangePackage(input: BuilderPlanInput): Promise<BuilderChangePackage>;
  applyChangePackage(pkg: BuilderChangePackage, options?: { dryRun?: boolean; actor?: string }): Promise<ApplyChangePackageResult>;
}

const VALID_RISK_LEVELS = new Set<RiskLevel>([
  "read_only",
  "draft_only",
  "local_write",
  "external_write",
  "destructive",
  "financial",
  "compliance_sensitive",
]);

function compact(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function packageIdempotency(input: BuilderPlanInput, affectedFiles: string[], diffSummary: string): string {
  return makeIdempotencyKey({
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    actionType: "builder.codex_cli.change_package",
    target: input.repoPath ?? "repository",
    payload: {
      goal: input.goal,
      affectedFiles,
      diffSummary,
    },
  });
}

function ledgerId(idempotencyKey: string): string {
  return `builder_${idempotencyKey.slice(-8)}`;
}

export function validateChangePackage(pkg: BuilderChangePackage): string[] {
  const errors: string[] = [];
  if (!pkg.goal.trim()) errors.push("goal is required");
  if (!Array.isArray(pkg.affectedFiles)) errors.push("affectedFiles must be an array");
  if (!pkg.diff && !pkg.diffSummary.trim()) errors.push("diff or diffSummary is required");
  if (!Array.isArray(pkg.testPlan) || pkg.testPlan.length === 0) errors.push("testPlan is required");
  if (!Array.isArray(pkg.rollbackPlan) || pkg.rollbackPlan.length === 0) errors.push("rollbackPlan is required");
  if (!VALID_RISK_LEVELS.has(pkg.riskLevel)) errors.push("riskLevel is invalid");
  if (!pkg.idempotencyKey.startsWith("idem_")) errors.push("idempotencyKey must be stable");
  if (!pkg.auditSummary.trim()) errors.push("auditSummary is required");
  return errors;
}

function parsePayload(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function approvedRiskGate(cycleId: string | null | undefined, idempotencyKey: string) {
  if (!cycleId) return undefined;
  return storage.listGates().find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.status !== "approved") return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "builder_apply_change_package" && payload.idempotencyKey === idempotencyKey;
  });
}

function ensureApplyRiskGate(input: { cycleId?: string | null; idempotencyKey: string; pkg: BuilderChangePackage }) {
  if (!input.cycleId) return undefined;
  const existing = storage.listGates().find((gate) => {
    if (gate.cycleId !== input.cycleId || gate.type !== "risk") return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "builder_apply_change_package" && payload.idempotencyKey === input.idempotencyKey;
  });
  if (existing) return existing;
  return storage.createGate({
    id: `gate_builder_apply_${input.idempotencyKey.slice(-8)}`,
    cycleId: input.cycleId,
    type: "risk",
    blocking: 1,
    title: "Builder 变更包 apply 审批",
    payload: withDecisionBriefPayload({
      riskKey: "builder_apply_change_package",
      idempotencyKey: input.idempotencyKey,
      goal: input.pkg.goal,
      affectedFiles: input.pkg.affectedFiles,
      riskLevel: input.pkg.riskLevel,
      rollbackPlan: input.pkg.rollbackPlan,
      auditSummary: input.pkg.auditSummary,
      createdAt: now(),
    }, createDecisionBrief({
      claim: `Apply builder change package for ${input.pkg.goal}`,
      metric: "builder_apply_approval",
      timeWindow: "before non-dry-run apply",
      ifApproved: "The non-dry-run builder apply path may proceed if shell capability also allows it.",
      ifRejected: "The change package stays blocked and no patch is applied.",
      rollbackRef: "payload.rollbackPlan",
    })),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
}

function upsertBuilderLedger(input: {
  pkg: BuilderChangePackage;
  projectId: string;
  cycleId?: string | null;
  status: string;
  reason: string;
  approvalGateId?: string | null;
}) {
  const timestamp = now();
  return storage.upsertActionLedger({
    id: ledgerId(input.pkg.idempotencyKey),
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    actionType: "builder.codex_cli.apply_change_package",
    target: input.pkg.affectedFiles.join(","),
    riskLevel: input.pkg.riskLevel,
    requiresApproval: 1,
    approvalGateId: input.approvalGateId ?? null,
    idempotencyKey: input.pkg.idempotencyKey,
    status: input.status,
    rollbackPlan: JSON.stringify(redactSensitiveData(input.pkg.rollbackPlan)),
    auditSummary: JSON.stringify(redactSensitiveData({ summary: input.pkg.auditSummary, reason: input.reason })),
    payload: JSON.stringify(redactSensitiveData({
      goal: input.pkg.goal,
      affectedFiles: input.pkg.affectedFiles,
      diffSummary: input.pkg.diffSummary,
      dryRun: input.pkg.dryRun,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export class CodexCliBuilderAdapter implements BuilderAdapter {
  async planChange(input: BuilderPlanInput): Promise<BuilderChangePackage> {
    return this.generateChangePackage(input);
  }

  async generateChangePackage(input: BuilderPlanInput): Promise<BuilderChangePackage> {
    const affectedFiles = input.requestedFiles?.length
      ? input.requestedFiles.slice(0, 20)
      : ["(dry-run) files to be selected after human review"];
    const diffSummary = `Dry-run Codex CLI package for: ${compact(input.goal)}`;
    const idempotencyKey = packageIdempotency(input, affectedFiles, diffSummary);
    const pkg: BuilderChangePackage = {
      projectId: input.projectId,
      cycleId: input.cycleId ?? null,
      goal: input.goal,
      affectedFiles,
      diffSummary,
      testPlan: [
        "npm run guard",
        "npm run typecheck",
        "npm run test:all",
        "npm run build",
      ],
      rollbackPlan: [
        "Do not apply automatically.",
        "Review generated diff before any local write.",
        "If applied manually and tests fail, revert only the reviewed patch hunks.",
      ],
      riskLevel: "local_write",
      idempotencyKey,
      auditSummary: "Codex CLI adapter generated a dry-run, rollback-ready change package without shell execution.",
      dryRun: true,
      adapter: "codex_cli",
    };
    const errors = validateChangePackage(pkg);
    if (errors.length > 0) throw new Error(`invalid builder change package: ${errors.join("; ")}`);
    recordActionProposal({
      projectId: input.projectId,
      cycleId: input.cycleId ?? null,
      actionType: "builder.codex_cli.generate_change_package",
      target: input.repoPath ?? "repository",
      explicitRiskLevel: "draft_only",
      payload: {
        goal: input.goal,
        affectedFiles: pkg.affectedFiles,
        idempotencyKey,
        dryRun: true,
      },
      rollbackPlan: pkg.rollbackPlan,
      auditSummary: pkg.auditSummary,
    });
    recordTrace({
      projectId: input.projectId,
      cycleId: input.cycleId ?? null,
      cycleIdx: input.cycleId ? storage.getCycle(input.cycleId)?.idx ?? null : null,
      kind: "action_risk",
      name: "builder_change_package_generated",
      agent: "builder",
      attributes: {
        adapter: "codex_cli",
        idempotencyKey,
        dryRun: true,
        affectedFiles: pkg.affectedFiles,
      },
    });
    return pkg;
  }

  async applyChangePackage(pkg: BuilderChangePackage, options: { dryRun?: boolean; actor?: string } = {}): Promise<ApplyChangePackageResult> {
    const projectId = pkg.projectId;
    const cycleId = pkg.cycleId ?? null;
    const validation = validateChangePackage(pkg);
    if (validation.length > 0) throw new Error(`invalid builder change package: ${validation.join("; ")}`);

    if (options.dryRun !== false) {
      const row = upsertBuilderLedger({ pkg, projectId, cycleId, status: "dry_run", reason: "dry-run apply only" });
      return { status: "dry_run", applied: false, reason: "dry-run apply only", idempotencyKey: pkg.idempotencyKey, actionLedgerId: row.id };
    }

    const mode = runModeFromEnv();
    if (mode === "production" || mode === "shadow") {
      const row = upsertBuilderLedger({ pkg, projectId, cycleId, status: "blocked", reason: `apply is disabled in ${mode} mode` });
      return { status: "blocked", applied: false, reason: `apply is disabled in ${mode} mode`, idempotencyKey: pkg.idempotencyKey, actionLedgerId: row.id };
    }

    const capability = evaluateCapability("shell_execution");
    auditCapabilityDecision({
      actor: options.actor ?? "builder",
      capability: "shell_execution",
      target: "codex_cli.apply_change_package",
      projectId,
      cycleId,
      payload: { idempotencyKey: pkg.idempotencyKey, affectedFiles: pkg.affectedFiles },
    }, capability);
    if (capability.dryRun || !capability.allowed) {
      const row = upsertBuilderLedger({
        pkg,
        projectId,
        cycleId,
        status: capability.dryRun ? "dry_run" : "blocked",
        reason: capability.reason,
      });
      return {
        status: capability.dryRun ? "dry_run" : "blocked",
        applied: false,
        reason: capability.reason,
        idempotencyKey: pkg.idempotencyKey,
        actionLedgerId: row.id,
      };
    }

    const approvedGate = approvedRiskGate(cycleId, pkg.idempotencyKey);
    const riskGate = approvedGate ?? ensureApplyRiskGate({ cycleId, idempotencyKey: pkg.idempotencyKey, pkg });
    if (!approvedGate) {
      const row = upsertBuilderLedger({
        pkg,
        projectId,
        cycleId,
        status: "blocked",
        reason: "approved risk gate with matching idempotency key is required",
        approvalGateId: riskGate?.id ?? null,
      });
      return {
        status: "blocked",
        applied: false,
        reason: "approved risk gate with matching idempotency key is required",
        idempotencyKey: pkg.idempotencyKey,
        actionLedgerId: row.id,
        approvalGateId: riskGate?.id ?? null,
      };
    }

    const row = upsertBuilderLedger({
      pkg,
      projectId,
      cycleId,
      status: "approved",
      reason: "approved for manual apply path; adapter does not execute patches automatically",
      approvalGateId: approvedGate.id,
    });
    recordTrace({
      projectId,
      cycleId,
      cycleIdx: cycleId ? storage.getCycle(cycleId)?.idx ?? null : null,
      kind: "action_risk",
      name: "builder_apply_package_approved",
      agent: "builder",
      attributes: { idempotencyKey: pkg.idempotencyKey, approvalGateId: approvedGate.id, applied: false },
    });
    return {
      status: "approved",
      applied: false,
      reason: "approved for manual apply path; adapter does not execute patches automatically",
      idempotencyKey: pkg.idempotencyKey,
      actionLedgerId: row.id,
      approvalGateId: approvedGate.id,
    };
  }
}
