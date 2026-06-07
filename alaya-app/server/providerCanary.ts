import { callLlm, classifyLlmFailure, type LlmFailureType } from "./llm";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";

export interface ProviderCanaryInput {
  projectId: string;
  cycleId?: string | null;
  provider?: "mock" | "openai";
  model?: string;
  role?: "orchestrator" | "sensor" | "builder" | "distiller" | "librarian";
  forceFailure?: "schema_error" | "provider_error";
}

export interface ProviderCanaryResult {
  projectId: string;
  cycleId: string;
  provider: string;
  model: string;
  role: string;
  ok: boolean;
  latencyMs: number;
  llmFailureType: LlmFailureType | null;
  schemaValid: boolean;
  traceableLlmCallId: number | null;
}

function latestCycleId(projectId: string): string {
  return storage.listCycles(projectId).at(-1)?.id ?? `canary_${projectId}`;
}

function routeOverride(role: string, provider?: string, model?: string): string | undefined {
  if (!provider && !model) return undefined;
  return JSON.stringify({ [role]: { provider: provider ?? "mock", model: model ?? `${provider ?? "mock"}-canary` } });
}

export async function runProviderCanary(input: ProviderCanaryInput): Promise<ProviderCanaryResult> {
  const role = input.role ?? "orchestrator";
  const cycleId = input.cycleId ?? latestCycleId(input.projectId);
  const override = routeOverride(role, input.provider, input.model);
  const routeEnv = override
    ? { ...process.env, ALAYA_MODEL_ROUTING_JSON: override }
    : undefined;
  const started = Date.now();
  const llmCallCountBefore = storage.listLlmCalls().length;
  let ok = false;
  let failureType: LlmFailureType | null = null;
  try {
    if (input.forceFailure === "provider_error") throw new Error("provider error: forced canary failure");
    const mockOutput = input.forceFailure === "schema_error"
      ? { wrongKey: "not schema valid" }
      : { summary: "provider canary ok" };
    const output = await callLlm({
      cycleId,
      agent: role,
      promptName: "provider_canary",
      inputSummary: "health-check provider/model/role route",
      mockOutput,
      schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
      context: {
        canary: true,
        projectId: input.projectId,
        forceFailure: input.forceFailure ?? null,
      },
      routeEnv,
    });
    ok = typeof output.summary === "string";
    if (!ok) failureType = "schema_error";
  } catch (error) {
    failureType = classifyLlmFailure(error);
  }

  const latencyMs = Date.now() - started;
  const lastCall = storage.listLlmCalls()
    .slice(llmCallCountBefore)
    .reverse()
    .find((call) => call.cycleId === cycleId && call.agent === role);
  const result: ProviderCanaryResult = {
    projectId: input.projectId,
    cycleId,
    provider: lastCall?.provider ?? input.provider ?? process.env.ALAYA_LLM_PROVIDER ?? "mock",
    model: lastCall?.model ?? input.model ?? "mock",
    role,
    ok,
    latencyMs,
    llmFailureType: failureType ?? (lastCall?.llmFailureType as LlmFailureType | null) ?? null,
    schemaValid: lastCall ? lastCall.schemaValid === 1 : ok,
    traceableLlmCallId: lastCall?.id ?? null,
  };
  const cycle = storage.getCycle(cycleId);
  recordTrace({
    projectId: input.projectId,
    cycleId,
    cycleIdx: cycle?.idx ?? null,
    kind: "llm_call",
    name: "provider_canary",
    agent: role,
    status: result.ok ? "ok" : "error",
    durationMs: latencyMs,
    attributes: {
      provider: result.provider,
      model: result.model,
      role,
      ok: result.ok,
      llmFailureType: result.llmFailureType,
      traceableLlmCallId: result.traceableLlmCallId,
      ts: now(),
    },
  });
  return result;
}
