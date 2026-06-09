import { storage, now } from "./storage";
import { readFileSync } from "node:fs";
import { resolveModelRoute } from "@shared/core/model_router.js";
import { recordTrace } from "./trace";
import { assertNetworkAllowed, requireCapability } from "./security/capabilities";
import { redactSensitiveData, redactSensitiveText } from "./security/redact";
import type { ModelRoute } from "@shared/core/types.js";

type JsonSchema = {
  type: "object";
  required?: string[];
  properties?: Record<string, { type: string; items?: JsonSchema }>;
  additionalProperties?: boolean;
};

export type LlmFailureType =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "schema_error"
  | "invalid_json"
  | "safety_refusal"
  | "network"
  | "provider_error"
  | "unknown";

interface LlmCallInput {
  cycleId: string;
  agent: string;
  promptName: string;
  inputSummary: string;
  mockOutput: Record<string, unknown>;
  routeEnv?: Record<string, string | undefined>;
  schema?: JsonSchema;
  simplifiedSchema?: JsonSchema;
  context?: Record<string, unknown>;
  knowledgeSummary?: string;
  prohibited?: string[];
}

type TokenSource = "provider" | "estimated";

interface ProviderTokenUsage {
  inputTokenCount?: number;
  outputTokenCount?: number;
  tokenCount?: number;
}

interface LlmProviderResult {
  data: Record<string, unknown>;
  usage?: ProviderTokenUsage;
}

const DEFAULT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: true,
  properties: { summary: { type: "string" } },
};
const DEFAULT_SIMPLIFIED_SCHEMA = DEFAULT_SCHEMA;
const BASE_SYSTEM_INSTRUCTIONS =
  "You are an Alaya agent. Return concise JSON only. Match the supplied schema exactly, using [] for empty arrays. " +
  "If draft_output already satisfies the schema, copy its key names exactly and adapt content only when evidence requires it.";

export function buildSystemInstructions(input: Pick<LlmCallInput, "knowledgeSummary">): string {
  const priorKnowledge = input.knowledgeSummary?.trim();
  return priorKnowledge ? `${priorKnowledge}\n\n${BASE_SYSTEM_INSTRUCTIONS}` : BASE_SYSTEM_INSTRUCTIONS;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarize(value: unknown, max = 240): string {
  const s = stableStringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sanitizeValue(value: unknown): unknown {
  return redactSensitiveData(value);
}

function sanitizeInput(input: LlmCallInput): LlmCallInput {
  return {
    ...input,
    inputSummary: redactSensitiveText(input.inputSummary),
    mockOutput: sanitizeValue(input.mockOutput) as Record<string, unknown>,
    context: sanitizeValue(input.context ?? {}) as Record<string, unknown>,
    knowledgeSummary: input.knowledgeSummary ? redactSensitiveText(input.knowledgeSummary) : input.knowledgeSummary,
    prohibited: input.prohibited?.map(redactSensitiveText),
  };
}

function approxTokens(value: unknown): number {
  return Math.max(1, Math.ceil(stableStringify(value).length / 4));
}

function estimateCost(tokens: number): number {
  return +(tokens * 0.000002).toFixed(6);
}

function tokenInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function extractProviderUsage(json: unknown): ProviderTokenUsage | undefined {
  if (!json || typeof json !== "object") return undefined;
  const usage = (json as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const inputTokenCount = tokenInteger(raw.prompt_tokens) ?? tokenInteger(raw.input_tokens);
  const outputTokenCount = tokenInteger(raw.completion_tokens) ?? tokenInteger(raw.output_tokens);
  const tokenCount = tokenInteger(raw.total_tokens);
  if (inputTokenCount == null && outputTokenCount == null && tokenCount == null) return undefined;
  return { inputTokenCount, outputTokenCount, tokenCount };
}

function tokenMetrics(
  input: LlmCallInput,
  data: Record<string, unknown>,
  usage?: ProviderTokenUsage,
): { inputTokenCount: number; outputTokenCount: number; tokenCount: number; tokenSource: TokenSource } {
  const estimatedInputTokens = approxTokens(llmInputForLog(input));
  const estimatedOutputTokens = approxTokens(data);
  if (!usage) {
    return {
      inputTokenCount: estimatedInputTokens,
      outputTokenCount: estimatedOutputTokens,
      tokenCount: estimatedInputTokens + estimatedOutputTokens,
      tokenSource: "estimated",
    };
  }

  let inputTokenCount = usage.inputTokenCount;
  let outputTokenCount = usage.outputTokenCount;
  let tokenCount = usage.tokenCount;

  if (tokenCount == null) {
    tokenCount = (inputTokenCount ?? 0) + (outputTokenCount ?? 0);
  }
  if (inputTokenCount == null && outputTokenCount == null) {
    const estimatedTotal = estimatedInputTokens + estimatedOutputTokens;
    inputTokenCount = estimatedTotal > 0
      ? Math.min(tokenCount, Math.round((tokenCount * estimatedInputTokens) / estimatedTotal))
      : tokenCount;
    outputTokenCount = Math.max(0, tokenCount - inputTokenCount);
  } else if (inputTokenCount == null) {
    inputTokenCount = Math.max(0, tokenCount - (outputTokenCount ?? 0));
  } else if (outputTokenCount == null) {
    outputTokenCount = Math.max(0, tokenCount - inputTokenCount);
  }

  return {
    inputTokenCount: inputTokenCount ?? 0,
    outputTokenCount: outputTokenCount ?? 0,
    tokenCount,
    tokenSource: "provider",
  };
}

function requestTimeoutMs(): number {
  const raw = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 90_000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 90_000;
}

function maxOutputTokens(): number {
  const raw = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 512);
  return Number.isFinite(raw) ? Math.max(64, Math.floor(raw)) : 512;
}

function readSecretFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function openAiApiKey(): string {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  return readSecretFile(process.env.OPENAI_API_KEY_FILE);
}

function validate(data: unknown, schema: JsonSchema): boolean {
  return validationErrors(data, schema).length === 0;
}

function validationErrors(data: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type !== "object" || data === null || typeof data !== "object" || Array.isArray(data)) return [`${path} should be object`];
  const obj = data as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) errors.push(`${path}.${key} is required`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue;
    if (prop.type === "array") {
      if (!Array.isArray(obj[key])) errors.push(`${path}.${key} should be array`);
    } else if (prop.type === "number") {
      if (typeof obj[key] !== "number" || !Number.isFinite(obj[key])) errors.push(`${path}.${key} should be number`);
    } else if (prop.type === "boolean") {
      if (typeof obj[key] !== "boolean") errors.push(`${path}.${key} should be boolean`);
    } else if (typeof obj[key] !== prop.type) {
      errors.push(`${path}.${key} should be ${prop.type}`);
    }
  }
  return errors;
}

function promptVersion(promptName: string) {
  return `${promptName}@v1`;
}

function llmInputForLog(input: LlmCallInput) {
  return {
    input: input.inputSummary,
    context: input.context ?? {},
    knowledgeSummary: input.knowledgeSummary ?? "",
    prohibited: input.prohibited ?? [],
  };
}

function record(
  input: LlmCallInput,
  route: ModelRoute,
  data: Record<string, unknown>,
  schemaValid: boolean,
  retryCount: number,
  latencyMs: number,
  failureType: LlmFailureType | null = null,
  usage?: ProviderTokenUsage,
) {
  const { inputTokenCount, outputTokenCount, tokenCount, tokenSource } = tokenMetrics(input, data, usage);
  storage.recordLlmCall({
    cycleId: input.cycleId,
    agent: input.agent,
    provider: route.provider,
    model: route.model,
    routeReason: route.routeReason,
    promptVersion: promptVersion(input.promptName),
    inputSummary: summarize(llmInputForLog(input)),
    outputSummary: summarize(sanitizeValue(data)),
    schemaValid: schemaValid ? 1 : 0,
    llmFailureType: failureType,
    retryCount,
    latencyMs,
    inputTokenCount,
    outputTokenCount,
    tokenCount,
    tokenSource,
    estimatedCost: estimateCost(tokenCount),
    ts: now(),
  });
  const cycle = storage.getCycle(input.cycleId);
  if (cycle) {
    recordTrace({
      projectId: cycle.projectId,
      cycleId: input.cycleId,
      cycleIdx: cycle.idx,
      kind: "llm_call",
      name: input.promptName,
      agent: input.agent,
      status: schemaValid ? "ok" : "error",
      durationMs: latencyMs,
      attributes: {
        promptVersion: promptVersion(input.promptName),
        provider: route.provider,
        model: route.model,
        routeReason: route.routeReason,
        schemaValid,
        llmFailureType: failureType,
        retryCount,
        inputTokenCount,
        outputTokenCount,
        tokenCount,
        tokenSource,
        estimatedCost: estimateCost(tokenCount),
      },
    });
  }
}

function diagnosticGateThrottleMs(): number {
  const raw = Number(process.env.ALAYA_LLM_DIAGNOSTIC_GATE_THROTTLE_MS ?? 15 * 60 * 1000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 15 * 60 * 1000;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function updateRecentDegradedGate(input: LlmCallInput, reason: string, timestamp: string): boolean {
  const throttleMs = diagnosticGateThrottleMs();
  if (throttleMs <= 0) return false;
  const cycle = storage.getCycle(input.cycleId);
  const gates = storage.listGates(cycle?.projectId).slice().reverse();
  const title = `LLM 输出降级: ${input.agent}/${input.promptName}`;
  const version = promptVersion(input.promptName);
  const cutoff = Date.now() - throttleMs;

  for (const gate of gates) {
    if (gate.title !== title) continue;
    const payload = parseObject(gate.payload);
    if (payload.promptVersion !== version || payload.category !== "llm_schema_degradation") continue;
    const lastSeenAt = typeof payload.lastSeenAt === "string"
      ? payload.lastSeenAt
      : typeof payload.createdAt === "string"
        ? payload.createdAt
        : "";
    const lastSeenMs = Date.parse(lastSeenAt);
    if (Number.isFinite(lastSeenMs) && lastSeenMs < cutoff) continue;
    if (!Number.isFinite(lastSeenMs) && gate.status !== "pending") continue;
    const suppressedCount = typeof payload.suppressedCount === "number" && Number.isFinite(payload.suppressedCount)
      ? payload.suppressedCount
      : 0;
    storage.updateGate(gate.id, {
      payload: JSON.stringify({
        ...payload,
        lastReason: redactSensitiveText(reason),
        lastSeenAt: timestamp,
        suppressedCount: suppressedCount + 1,
      }),
    });
    return true;
  }
  return false;
}

function createDegradedGate(input: LlmCallInput, reason: string) {
  const timestamp = now();
  if (updateRecentDegradedGate(input, reason, timestamp)) return;
  const id = `gate_llm_${input.agent}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  storage.createGate({
    id,
    cycleId: input.cycleId,
    type: "meaning",
    blocking: 0,
    title: `LLM 输出降级: ${input.agent}/${input.promptName}`,
    payload: JSON.stringify({
      source: "system_diagnostic",
      category: "llm_schema_degradation",
      topicKey: "llm_schema_degradation",
      reason: redactSensitiveText(reason),
      promptVersion: promptVersion(input.promptName),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      suppressedCount: 0,
    }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });
}

export async function callLlm(input: LlmCallInput): Promise<Record<string, unknown>> {
  const safeInput = sanitizeInput(input);
  const schema = input.schema ?? DEFAULT_SCHEMA;
  const started = Date.now();
  const route = resolveModelRoute(input.agent, input.routeEnv ?? process.env);
  const provider = route.provider;

  if (provider !== "openai") {
    const schemaValid = validate(input.mockOutput, schema);
    record(safeInput, route, input.mockOutput, schemaValid, 0, Date.now() - started, schemaValid ? null : "schema_error");
    if (!schemaValid) createDegradedGate(safeInput, "mock output failed schema validation");
    return input.mockOutput;
  }

  const capability = requireCapability({
    actor: input.agent,
    capability: "llm_call",
    target: route.model,
    cycleId: input.cycleId,
    payload: { provider: route.provider, model: route.model, promptName: input.promptName },
  });
  if (capability.dryRun) {
    const data = { summary: `LLM dry-run: ${route.provider}/${route.model} was not called` };
    record(safeInput, route, data, false, 0, Date.now() - started, "unknown");
    return data;
  }

  const apiKey = openAiApiKey();
  if (!apiKey) {
    const data = { summary: `OpenAI disabled: missing OPENAI_API_KEY` };
    record(safeInput, route, data, false, 0, Date.now() - started, "auth");
    createDegradedGate(safeInput, "OPENAI_API_KEY is not set");
    return data;
  }

  let lastError = "";
  let transportRetries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callOpenAIWithRetry(safeInput, schema, redactSensitiveText(lastError), apiKey, route.model);
      const data = result.data;
      transportRetries += result.retries;
      const errors = validationErrors(data, schema);
      if (errors.length === 0) {
        record(safeInput, route, data, true, attempt + transportRetries, Date.now() - started, null, result.usage);
        return data;
      }
      lastError = `schema validation failed: ${errors.join("; ")}. Include every required key; use [] for empty arrays.`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    const simpleSchema = input.simplifiedSchema ?? DEFAULT_SIMPLIFIED_SCHEMA;
    const simpleResult = await callOpenAIWithRetry(
      safeInput,
      simpleSchema,
      `response failed JSON schema validation; return simplified JSON summary only. ${redactSensitiveText(lastError)}`,
      apiKey,
      route.model,
    );
    transportRetries += simpleResult.retries;
    const simpleData = simpleResult.data;
    if (validate(simpleData, simpleSchema)) {
      const originalErrors = validationErrors(simpleData, schema);
      if (originalErrors.length === 0) {
        record(safeInput, route, simpleData, true, 2 + transportRetries, Date.now() - started, null, simpleResult.usage);
        return simpleData;
      }
      record(safeInput, route, simpleData, false, 2 + transportRetries, Date.now() - started, "schema_error", simpleResult.usage);
      createDegradedGate(safeInput, `degraded to simplified schema after: ${lastError || "schema validation failed"}`);
      return simpleData;
    }
    lastError = "simplified schema validation failed";
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const simplified = { summary: `LLM degraded for ${input.agent}/${input.promptName}: ${lastError}` };
  record(safeInput, route, simplified, false, 3 + transportRetries, Date.now() - started, classifyLlmFailure(lastError || "schema validation failed"));
  createDegradedGate(safeInput, lastError || "schema validation failed");
  return simplified;
}

export function getLlmRetryPolicy() {
  const raw = Number(process.env.OPENAI_MAX_RETRIES ?? 3);
  const maxRetries = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 3) : 3;
  return { maxRetries, baseDelayMs: retryDelayMs(1) };
}

function maxTransportRetries(): number {
  return getLlmRetryPolicy().maxRetries;
}

function retryDelayMs(attempt: number): number {
  const base = Math.max(0, Number(process.env.OPENAI_RETRY_BASE_MS ?? 2_000));
  return Math.min(30_000, base * 2 ** Math.max(0, attempt - 1));
}

function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:429|5\d\d)\b/.test(message);
}

export function classifyLlmFailure(error: unknown): LlmFailureType {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/\btimeout|timed out|aborterror|aborted\b/.test(message)) return "timeout";
  if (/\b429|rate limit|too many requests\b/.test(message)) return "rate_limit";
  if (/\b401|403|unauthorized|forbidden|invalid api key|missing openai_api_key|auth\b/.test(message)) return "auth";
  if (/\bschema validation|should be|required|schema_error\b/.test(message)) return "schema_error";
  if (/\bnot parseable json|invalid json|json.parse|unexpected token\b/.test(message)) return "invalid_json";
  if (/\bsafety|refusal|refused|policy violation\b/.test(message)) return "safety_refusal";
  if (/\benotfound|econnreset|econnrefused|network|fetch failed|getaddrinfo\b/.test(message)) return "network";
  if (/\bopenai|provider|5\d\d|bad gateway|service unavailable\b/.test(message)) return "provider_error";
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAIWithRetry(
  input: LlmCallInput,
  schema: JsonSchema,
  previousError: string,
  apiKey: string,
  model: string,
): Promise<LlmProviderResult & { retries: number }> {
  let retries = 0;
  let lastError: unknown;
  const maxRetries = maxTransportRetries();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return { ...await callOpenAI(input, schema, previousError, apiKey, model), retries };
    } catch (error) {
      lastError = error;
      if (!isRetryableLlmError(error) || attempt === maxRetries) break;
      retries += 1;
      await sleep(retryDelayMs(retries));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callOpenAI(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<LlmProviderResult> {
  const mode = resolveOpenAIApiMode();
  if (mode === "chat") return callChatCompletions(input, schema, previousError, apiKey, model);
  return callResponses(input, schema, previousError, apiKey, model);
}

type OpenAIApiMode = "responses" | "chat";

function resolveOpenAIApiMode(): OpenAIApiMode {
  const raw = process.env.OPENAI_API_MODE ?? process.env.OPENAI_COMPAT_MODE;
  if (raw === "chat" || raw === "responses") return raw;
  if (process.env.OPENAI_BASE_URL || process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT) return "chat";
  return "responses";
}

function chatCompletionsEndpoint(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  const minimaxAlias = minimaxChatEndpointAlias(clean);
  if (minimaxAlias) return minimaxAlias;
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

function minimaxChatEndpointAlias(cleanBaseUrl: string): string | undefined {
  try {
    const url = new URL(cleanBaseUrl);
    if ((url.hostname === "api.minimax.io" || url.hostname === "api.minimaxi.com") && url.pathname === "/openai") {
      return `${url.origin}/v1/chat/completions`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function callResponses(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<LlmProviderResult> {
  const endpoint = process.env.OPENAI_RESPONSES_ENDPOINT ?? "https://api.openai.com/v1/responses";
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: maxOutputTokens(),
      instructions: buildSystemInstructions(input),
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: stableStringify({
            agent: input.agent,
            task: input.promptName,
            input_summary: input.inputSummary,
            context: input.context ?? {},
            knowledge_summary: input.knowledgeSummary ?? "",
            prohibited: input.prohibited ?? [],
            draft_output: input.mockOutput,
            previous_error: previousError,
          }),
        }],
      }],
      text: {
        format: {
          type: "json_schema",
          name: promptVersion(input.promptName).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
          schema,
          strict: false,
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const json = await response.json() as any;
  const text = extractOutputText(json);
  return { data: parseJsonObjectText(text, "OpenAI"), usage: extractProviderUsage(json) };
}

async function callChatCompletions(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<LlmProviderResult> {
  const endpoint = process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT
    ?? chatCompletionsEndpoint(process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxOutputTokens(),
      response_format: { type: "json_object" },
      ...providerChatExtras(model, endpoint),
      messages: [
        {
          role: "system",
          content: buildSystemInstructions(input),
        },
        {
          role: "user",
          content: stableStringify({
            agent: input.agent,
            task: input.promptName,
            input_summary: input.inputSummary,
            context: input.context ?? {},
            knowledge_summary: input.knowledgeSummary ?? "",
            prohibited: input.prohibited ?? [],
            draft_output: input.mockOutput,
            previous_error: previousError,
            output_schema: schema,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI-compatible chat ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const json = await response.json() as any;
  const text = extractChatOutputText(json);
  return { data: parseJsonObjectText(text, "OpenAI-compatible chat"), usage: extractProviderUsage(json) };
}

function providerChatExtras(model: string, endpoint: string): Record<string, unknown> {
  const target = `${model} ${endpoint}`.toLowerCase();
  if (!target.includes("minimax")) return {};
  const raw = (process.env.MINIMAX_THINKING ?? process.env.OPENAI_THINKING ?? "disabled").toLowerCase();
  const type = raw === "adaptive" ? "adaptive" : "disabled";
  return { thinking: { type } };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  assertNetworkAllowed(url, { actor: "llm", payload: { method: init.method ?? "GET" } });
  const timeoutMs = requestTimeoutMs();
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`OpenAI-compatible request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractOutputText(json: any): string {
  if (typeof json.output_text === "string") return json.output_text;
  for (const item of json.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function extractChatOutputText(json: any): string {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .join("");
  }
  return "";
}

function parseJsonObjectText(text: string, source: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  for (const candidate of [stripThinkingBlocks(trimmed), trimmed]) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) return parsed;
  }
  throw new Error(`${source} response was not parseable JSON: ${text.slice(0, 300)}`);
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try extracting a final JSON object from provider-specific wrapper text.
  }

  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  const starts: number[] = [];
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    starts.push(index);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(text.slice(starts[i], end + 1)) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Continue searching for the root object.
    }
  }
  return null;
}
