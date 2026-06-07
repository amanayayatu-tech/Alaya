import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-business-signals-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const {
  externalBusinessSignalInputSchema,
  importBusinessSignals,
  importBusinessSignalsFromFile,
} = await import("../server/businessSignals.ts");
const { buildKnowledgeContext } = await import("../server/knowledgeInjection.ts");

function seed(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "business signal ingestion",
    targetUser: "operator",
    redlines: "[]",
    weeklyHumanMinutes: 150,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "",
    worldModel: "",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_${projectId}`,
    projectId,
    idx: 1,
    goal: "ingest",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

test("ExternalBusinessSignal schema validates required fields", () => {
  const valid = externalBusinessSignalInputSchema.safeParse({
    source: "shopify_export",
    sourceId: "order-1",
    projectId: "proj_schema",
    signalType: "order",
    observedAt: "2026-06-07T00:00:00Z",
    payload: { sku: "A" },
    sensitivityLevel: "internal",
    dedupeKey: "shopify:order-1",
    riskLevel: "local_write",
  });
  assert.equal(valid.success, true);
  assert.equal(externalBusinessSignalInputSchema.safeParse({}).success, false);
});

test("JSON import creates feedback and meaning gate but no active knowledge", () => {
  const projectId = "proj_business_json";
  seed(projectId);

  const result = importBusinessSignals([{
    source: "shop_export",
    sourceId: "order-100",
    projectId,
    signalType: "order",
    observedAt: "2026-06-07T00:00:00Z",
    payload: { sku: "sku-1", amount: 42 },
    sensitivityLevel: "internal",
    dedupeKey: "shop:order-100",
    riskLevel: "local_write",
  }]);

  assert.equal(result.imported, 1);
  assert.equal(result.gatesCreated, 1);
  assert.equal(storage.listFeedback(`cycle_${projectId}`).length, 1);
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "meaning" && gate.status === "pending").length, 1);
  assert.equal(storage.listKnowledge(projectId).length, 0);
  assert.equal(buildKnowledgeContext("sku-1 order", projectId), "");
});

test("dedupe prevents repeated imports from duplicating feedback or gates", () => {
  const projectId = "proj_business_dedupe";
  seed(projectId);
  const row = {
    source: "crm_export",
    sourceId: "ticket-1",
    projectId,
    signalType: "customer_service",
    observedAt: "2026-06-07T00:00:00Z",
    payload: { text: "Need help" },
    sensitivityLevel: "internal",
    dedupeKey: "crm:ticket-1",
    riskLevel: "local_write",
  };

  assert.equal(importBusinessSignals([row]).imported, 1);
  assert.equal(importBusinessSignals([row]).skipped, 1);
  assert.equal(storage.listExternalBusinessSignals(projectId).length, 1);
  assert.equal(storage.listFeedback(`cycle_${projectId}`).length, 1);
  assert.equal(storage.listGates(projectId).length, 1);
});

test("sensitive payload is redacted in event_log, trace_events and action_ledger", () => {
  const projectId = "proj_business_sensitive";
  seed(projectId);
  const result = importBusinessSignals([{
    source: "health_device_export",
    sourceId: "reading-1",
    projectId,
    signalType: "health_signal",
    observedAt: "2026-06-07T00:00:00Z",
    payload: { email: "alice@example.com", phone: "+1 555 123 4567", heartRate: 190, note: "dizzy" },
    sensitivityLevel: "health_sensitive",
    dedupeKey: "health:reading-1",
    riskLevel: "compliance_sensitive",
  }]);

  assert.equal(result.imported, 1);
  const signal = storage.listExternalBusinessSignals(projectId)[0];
  assert.equal((JSON.parse(signal.payload) as any).redacted, true);
  const joined = [
    ...storage.listEvents().map((event) => `${event.before ?? ""}\n${event.after ?? ""}`),
    ...storage.listTraceEventsByProject(projectId).map((trace) => trace.attributes),
    ...storage.listActionLedger(projectId).map((row) => `${row.payload}\n${row.auditSummary ?? ""}`),
  ].join("\n");
  assert.doesNotMatch(joined, /alice@example\.com/);
  assert.doesNotMatch(joined, /555 123 4567/);
  assert.match(joined, /Sensitive business signal payload redacted/);
});

test("CSV and JSON local file adapters import rows", () => {
  const projectId = "proj_business_files";
  seed(projectId);
  const dir = mkdtempSync(join(tmpdir(), "alaya-business-file-"));
  const csv = join(dir, "signals.csv");
  writeFileSync(csv, [
    "source,sourceId,projectId,signalType,observedAt,payload,sensitivityLevel,dedupeKey,riskLevel",
    `market,file-1,${projectId},marketing_asset,2026-06-07T00:00:00Z,"{""asset"":""ad-1""}",public,market:file-1,local_write`,
  ].join("\n"));
  const json = join(dir, "signals.json");
  writeFileSync(json, JSON.stringify([{
    source: "finance",
    sourceId: "recon-1",
    projectId,
    signalType: "finance_reconciliation",
    observedAt: "2026-06-07T00:00:00Z",
    payload: { invoice: "INV-1" },
    sensitivityLevel: "financial",
    dedupeKey: "finance:recon-1",
    riskLevel: "compliance_sensitive",
  }]));

  assert.equal(importBusinessSignalsFromFile(csv).imported, 1);
  assert.equal(importBusinessSignalsFromFile(json).imported, 1);
  const signals = storage.listExternalBusinessSignals(projectId);
  assert.equal(signals.length, 2);
  const financeSignal = signals.find((signal) => signal.source === "finance");
  assert.equal(financeSignal?.riskLevel, "financial");
  const financeGate = storage.getGate(financeSignal?.gateId ?? "");
  assert.equal(JSON.parse(financeGate?.payload ?? "{}").riskLevel, "financial");
});
