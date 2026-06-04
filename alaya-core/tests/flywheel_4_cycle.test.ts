import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/state/store.js";
import { MockLLM } from "../src/llm/provider.js";
import { SCENARIO } from "../src/sim/scenario.js";
import {
  runOrchestrator,
  humanResolveDirectionGate,
  runSensor,
  runBuilder,
  evaluatePrediction,
  runDistiller,
  runLibrarian,
} from "../src/agents/agents.js";

function makeStore() {
  const store = new Store();
  store.project = {
    id: "proj_four_cycle_test",
    name: "四轮复利测试项目",
    direction: "帮独立开发者快速发布",
    targetUser: "独立开发者",
    redlines: ["不自动付款", "不自动公开发布"],
    weeklyHumanMinutes: 150,
  };
  return store;
}

test("core flywheel compounds through cycle 4 with rollback/audit assets", async () => {
  const store = makeStore();
  const llm = new MockLLM();

  for (const scenario of SCENARIO) {
    const plan = await runOrchestrator(store, scenario, llm);
    humanResolveDirectionGate(store, plan.gate, scenario);
    await runSensor(store, scenario, llm);
    await runBuilder(store, scenario, llm, plan.action, plan.refs);
    const { pred, claim } = evaluatePrediction(store, scenario, plan);
    await runDistiller(store, scenario, pred, claim.error ?? 0, llm);
    await runLibrarian(store, scenario, llm);
  }

  assert.equal(SCENARIO.length, 4);
  assert.equal(store.llmCalls.length, 20);

  for (const cycleIndex of [1, 2, 3, 4]) {
    const agents = new Set(store.agentRuns.filter((run) => run.cycleIndex === cycleIndex).map((run) => run.agent));
    assert.deepEqual([...agents].sort(), ["builder", "distiller", "librarian", "orchestrator", "sensor"]);
  }

  const cycle3Gate = store.gates.find((gate) => gate.cycleId === "cycle_3" && gate.type === "direction");
  assert.match(String(cycle3Gate?.payload.reasoning ?? ""), /改变|迁移|复用/);

  const cycle3Prediction = store.predictions.find((prediction) => prediction.cycleId === "cycle_3");
  const cycle4Prediction = store.predictions.find((prediction) => prediction.cycleId === "cycle_4");
  assert.ok(cycle3Prediction);
  assert.ok(cycle4Prediction);
  assert.equal(cycle4Prediction.id, "pred_c4_rollback");
  assert.notEqual(cycle4Prediction.action, cycle3Prediction.action);
  assert.match(cycle4Prediction.action, /回滚|审计/);

  const cycle4Gate = store.gates.find((gate) => gate.cycleId === "cycle_4" && gate.type === "direction");
  assert.ok(cycle4Gate);
  assert.equal(cycle4Gate.id, "gate_dir_c4_rollback");
  assert.ok(cycle4Gate.payload.rollbackPlan);
  assert.ok(cycle4Gate.payload.auditSummary);

  const cycle4Principle = [...store.knowledge.values()].find((item) => item.createdByCycle === 4 && item.type === "principle");
  assert.ok(cycle4Principle);
  assert.match(cycle4Principle.title, /可回滚路径与审计摘要/);
  assert.match(cycle4Principle.content, /rollback-ready change package/);
  assert.match(cycle4Principle.content, /audit summary/);
});
