import { OpenAIProvider, resolveOpenAIApiKey, type AgentContext, type JsonSchema } from "../llm/provider.js";

const allowSkip = process.env.ALAYA_E2E_ALLOW_SKIP === "true";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function skip(reason: string, extra: Record<string, unknown>) {
  if (!allowSkip) throw new Error(reason);
  console.log(JSON.stringify({ ok: false, skipped: true, reason, ...extra }, null, 2));
  process.exit(0);
}

const schema: JsonSchema = {
  type: "object",
  required: ["summary", "goal", "reasoning", "knowledgeRefs"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    goal: { type: "string" },
    reasoning: { type: "string" },
    knowledgeRefs: { type: "array" },
  },
};

const request: AgentContext = {
  role: "orchestrator",
  task: "layer1_real_llm_preflight",
  promptVersion: "layer1_real_llm_preflight@v1",
  schema,
  simplifiedSchema: {
    type: "object",
    required: ["summary"],
    additionalProperties: true,
    properties: { summary: { type: "string" } },
  },
  knowledgeSummary:
    "kb_001: 用户对不可预期自动操作有恐惧; kb_002: 可预览/可逆显著降低高风险动作门槛。",
  prohibited: [
    "Return JSON only.",
    "Do not execute external actions.",
    "Do not include credentials or secrets.",
  ],
  context: {
    cycleIndex: 3,
    candidateGoal: "把已验证的 dry-run 预览模式迁移到删除操作",
    rejectedDirections: ["先做高级定制能力", "直接推广一键发布"],
    acceptance:
      "Explain how prior knowledge changes the current decision instead of merely citing IDs.",
  },
};

async function verifyMissingKeyDegradation() {
  const provider = new OpenAIProvider({
    apiKey: "",
    apiMode: "chat",
    endpoint: "http://127.0.0.1:9/v1/chat/completions",
    model: "missing-key-self-test",
    maxRetries: 0,
  });
  const response = await provider.call(request);
  assert(response.degradedToHumanGate === true, "missing API key should degrade to human gate candidate");
  assert(response.schemaValid === false, "missing API key degraded response should be schema invalid for the full schema");
  assert(response.log.promptVersion === request.promptVersion, "degraded log should preserve promptVersion");
  assert(response.log.inputSummary.length > 0, "degraded log should include input summary");
  assert(response.log.outputSummary.length > 0, "degraded log should include output summary");
  assert(response.log.tokenCount > 0, "degraded log should estimate token count");
  const candidate = response.data.human_gate_candidate as { type?: string; blocking?: boolean } | undefined;
  assert(candidate?.type === "meaning", "degraded response should create a meaning gate candidate");
  assert(candidate?.blocking === false, "degraded response should be non-blocking");
  return {
    degradedToHumanGate: response.degradedToHumanGate,
    schemaValid: response.schemaValid,
    promptVersion: response.log.promptVersion,
    tokenCount: response.log.tokenCount,
  };
}

async function verifyRealOpenAICompatibleCall() {
  const provider = new OpenAIProvider({ maxRetries: 1 });
  const response = await provider.call(request);
  assert(response.degradedToHumanGate === false, response.errorMessage ?? "real LLM call degraded unexpectedly");
  assert(response.schemaValid === true, "real LLM response should satisfy the required JSON schema");
  assert(typeof response.data.summary === "string", "real LLM summary should be a string");
  assert(typeof response.data.goal === "string", "real LLM goal should be a string");
  assert(typeof response.data.reasoning === "string", "real LLM reasoning should be a string");
  assert(Array.isArray(response.data.knowledgeRefs), "real LLM knowledgeRefs should be an array");
  assert(response.log.provider === "openai", "real LLM provider should be openai-compatible adapter");
  assert(response.log.promptVersion === request.promptVersion, "real LLM log should preserve promptVersion");
  assert(response.log.inputSummary.length > 0, "real LLM log should include input summary");
  assert(response.log.outputSummary.length > 0, "real LLM log should include output summary");
  assert(response.log.schemaValid === true, "real LLM log should mark schema valid");
  assert(response.log.retryCount >= 0, "real LLM log should include retry count");
  assert(response.log.latencyMs >= 0, "real LLM log should include latency");
  assert(response.log.tokenCount > 0, "real LLM log should include token count");
  assert(response.log.estimatedCost >= 0, "real LLM log should include estimated cost");

  return {
    provider: response.log.provider,
    promptVersion: response.log.promptVersion,
    schemaValid: response.log.schemaValid,
    retryCount: response.log.retryCount,
    latencyMs: response.log.latencyMs,
    tokenCount: response.log.tokenCount,
    estimatedCost: response.log.estimatedCost,
    outputKeys: Object.keys(response.data).sort(),
  };
}

async function main() {
  const degradation = await verifyMissingKeyDegradation();
  if (!resolveOpenAIApiKey()) {
    skip("OPENAI_API_KEY or OPENAI_API_KEY_FILE is not set; real LLM call was not run.", { degradation });
  }

  const realCall = await verifyRealOpenAICompatibleCall();
  console.log(JSON.stringify({ ok: true, degradation, realCall }, null, 2));
}

main().catch((err) => {
  console.error(`LLM Provider E2E failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
