import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/state/store.js";
import { SCENARIO } from "../src/sim/scenario.js";
import { evaluatePrediction, runBuilder, runDistiller } from "../src/agents/agents.js";
import type { AgentContext, LLMProvider, LLMResponse } from "../src/llm/provider.js";

class ScriptedLLM implements LLMProvider {
  name = "openai";

  async call(request: AgentContext): Promise<LLMResponse> {
    const data = this.dataFor(request);
    return {
      schemaValid: true,
      retryCount: 0,
      data,
      log: {
        provider: this.name,
        agent: request.role,
        promptVersion: request.promptVersion,
        inputSummary: request.task,
        outputSummary: JSON.stringify(data),
        schemaValid: true,
        retryCount: 0,
        latencyMs: 1,
        tokenCount: 12,
        estimatedCost: 0.000001,
        ts: "2026-06-03T00:00:00.000Z",
      },
      degradedToHumanGate: false,
    };
  }

  private dataFor(request: AgentContext): Record<string, unknown> {
    if (request.role === "builder") {
      return {
        summary: "LLM emitted task spec",
        buildSuccess: false,
        diffSummary: "LLM diff: add auditable review checklist",
        testReport: "LLM test report: checklist reviewed by owner",
      };
    }
    if (request.role === "distiller") {
      return {
        summary: "LLM distilled a concrete knowledge candidate",
        knowledgeCandidates: [{
          createdByCycle: 1,
          title: "LLM K1: users need visible change boundaries",
          content: "LLM content: early users hesitate when the system cannot show what will change.",
          sourceRef: "llm:f1,f2",
          tags: ["llm_generated"],
          notes: "LLM notes should survive as candidate rationale.",
        }],
      };
    }
    return request.mockData ?? { summary: request.task };
  }
}

class DegradedLLM implements LLMProvider {
  name = "openai";

  async call(request: AgentContext): Promise<LLMResponse> {
    const data = { summary: `degraded ${request.role}` };
    return {
      schemaValid: false,
      retryCount: 2,
      data,
      log: {
        provider: this.name,
        agent: request.role,
        promptVersion: request.promptVersion,
        inputSummary: request.task,
        outputSummary: JSON.stringify(data),
        schemaValid: false,
        retryCount: 2,
        latencyMs: 3,
        tokenCount: 18,
        estimatedCost: 0.000002,
        ts: "2026-06-03T00:00:00.000Z",
      },
      degradedToHumanGate: true,
      errorMessage: "response failed JSON schema validation; simplified schema returned summary only",
    };
  }
}

function makeStore() {
  const store = new Store();
  store.project = {
    id: "proj_llm_agent_outputs",
    name: "LLM agent output contract",
    direction: "帮独立开发者快速发布",
    targetUser: "独立开发者",
    redlines: ["不自动付款", "不自动公开发布"],
    weeklyHumanMinutes: 150,
  };
  return store;
}

test("core builder consumes LLM task spec text while tool build result stays authoritative", async () => {
  const store = makeStore();
  const scenario = SCENARIO[0];
  const report = await runBuilder(store, scenario, new ScriptedLLM(), "build gated review checklist");

  assert.equal(report.buildSuccess, true, "tool-reported scenario build result remains authoritative");
  assert.equal(report.llmReportedBuildSuccess, false);
  assert.equal(report.diffSummary, "LLM diff: add auditable review checklist");
  assert.equal(report.testReport, "LLM test report: checklist reviewed by owner");
  assert.match(store.agentRuns.at(-1)?.outputSummary ?? "", /LLM diff: add auditable review checklist/);
});

test("core distiller consumes LLM knowledge candidate but preserves required governance tags", async () => {
  const store = makeStore();
  const scenario = SCENARIO[0];
  const { pred, claim } = evaluatePrediction(store, scenario, {
    belief: scenario.belief,
    prediction: scenario.prediction,
    action: scenario.action,
    refs: [],
  });

  const created = await runDistiller(store, scenario, pred, claim.error ?? 0, new ScriptedLLM());
  assert.equal(created.length, 1);
  const knowledge = store.knowledge.get(created[0]);
  assert.ok(knowledge);
  assert.equal(knowledge.title, "LLM K1: users need visible change boundaries");
  assert.equal(knowledge.content, "LLM content: early users hesitate when the system cannot show what will change.");
  assert.equal(knowledge.sourceRef, "llm:f1,f2");
  assert.equal(knowledge.notes, "LLM notes should survive as candidate rationale.");
  assert.deepEqual([...knowledge.tags].sort(), ["adoption", "llm_generated", "user_fear"]);
  assert.equal(knowledge.createdBy, "distiller");
  assert.equal(knowledge.status, "draft");
});

test("core agents create a non-blocking meaning gate when LLM output degrades", async () => {
  const store = makeStore();
  const scenario = SCENARIO[0];

  await runBuilder(store, scenario, new DegradedLLM(), "emit a degraded task spec");

  const gate = store.gates.find((item) => item.id.startsWith("gate_llm_"));
  assert.ok(gate);
  assert.equal(gate.type, "meaning");
  assert.equal(gate.blocking, false);
  assert.equal(gate.status, "pending");
  assert.equal(gate.estimatedMinutes, 5);
  assert.match(gate.title, /LLM 输出降级/);
  assert.match(String(gate.payload.error), /schema validation/);
  assert.equal(gate.payload.promptVersion, "emit_task_spec@v1");

  const call = store.llmCalls.find((item) => item.promptVersion === "emit_task_spec@v1");
  assert.ok(call);
  assert.equal(call.schemaValid, false);
  assert.equal(call.retryCount, 2);
});
