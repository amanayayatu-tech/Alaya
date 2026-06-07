import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-org-modules-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const {
  createOrgModule,
  updateOrgModule,
  orgModuleMarkdown,
  convertOrgModuleToKnowledge,
  parseOrgModule,
} = await import("../server/orgModules.ts");
const { buildKnowledgeContext } = await import("../server/knowledgeInjection.ts");

storage.createProject({
  id: "proj_org",
  name: "Org",
  direction: "organization knowledge",
  targetUser: "operators",
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
  id: "cycle_org",
  projectId: "proj_org",
  idx: 1,
  goal: "org",
  status: "planning",
  eCycle: null,
  worstClaimError: null,
  reasoning: "",
  version: 1,
});

test("org module schema and CRUD storage round trip", () => {
  const module = createOrgModule("proj_org", {
    moduleName: "Customer Support",
    problemSolved: "Turn customer messages into reviewed learning signals.",
    ownerRole: "Support lead",
    responsibilityBoundaries: ["Triage support", "Escalate product signals"],
    upstreamDependencies: ["Business signal adapter"],
    downstreamConsumers: ["Distiller", "Product planning"],
    dataInputs: ["tickets", "returns"],
    dataOutputs: ["meaning gates", "support summaries"],
    callChain: ["BusinessSignalAdapter -> Sensor -> MeaningGate"],
    mvpDefinition: "Import CSV tickets and create meaning gates.",
    testPlan: "CSV import, dedupe, redaction, gate creation.",
    executionPlan: "Start with local exports.",
    knownPitfalls: ["PII leakage"],
    redlines: ["No automatic customer promises"],
    version: "v1",
  });
  assert.equal(module.moduleName, "Customer Support");
  assert.deepEqual(parseOrgModule(module).dataInputs, ["tickets", "returns"]);

  const updated = updateOrgModule(module.id, { ownerRole: "Ops owner", dataOutputs: ["reviewed gates"] });
  assert.equal(updated?.ownerRole, "Ops owner");
  assert.deepEqual(parseOrgModule(updated!).dataOutputs, ["reviewed gates"]);
  assert.equal(storage.listOrgModules("proj_org").length, 1);
});

test("markdown export snapshot is stable", () => {
  const module = storage.listOrgModules("proj_org")[0];
  const markdown = orgModuleMarkdown(module);
  assert.match(markdown, /^# Customer Support/);
  assert.match(markdown, /## Problem Solved\nTurn customer messages into reviewed learning signals\./);
  assert.match(markdown, /## Redlines\n- No automatic customer promises/);
});

test("knowledge conversion preserves provenance and remains draft until approved", () => {
  const module = storage.listOrgModules("proj_org")[0];
  const knowledge = convertOrgModuleToKnowledge(module.id);

  assert.equal(knowledge.status, "draft");
  assert.match(knowledge.sourceRef, new RegExp(`org_module:${module.id}:v1`));
  assert.match(knowledge.notes, /Draft status prevents automatic operational injection/);
  assert.equal(storage.getOrgModule(module.id)?.knowledgeId, knowledge.id);

  const search = storage.searchKnowledge("proj_org", "Customer Support");
  assert.ok(search.some((item) => item.id === knowledge.id), "draft module knowledge should be searchable");
  const context = buildKnowledgeContext("Customer Support meaning gates", "proj_org");
  assert.doesNotMatch(context, new RegExp(knowledge.id), "draft org module knowledge must not be injected");
});

test("org module can be deleted without deleting converted knowledge history", () => {
  const module = createOrgModule("proj_org", {
    moduleName: "Finance Reconciliation",
    problemSolved: "Review financial signals.",
    ownerRole: "Finance owner",
    responsibilityBoundaries: [],
    upstreamDependencies: [],
    downstreamConsumers: [],
    dataInputs: [],
    dataOutputs: [],
    callChain: [],
    mvpDefinition: "",
    testPlan: "",
    executionPlan: "",
    knownPitfalls: [],
    redlines: [],
    version: "v1",
  });
  const knowledge = convertOrgModuleToKnowledge(module.id);
  assert.equal(storage.deleteOrgModule(module.id), true);
  assert.ok(storage.getKnowledge(knowledge.id));
});
