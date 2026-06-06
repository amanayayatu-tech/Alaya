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

interface LlmCallInput {
  cycleId: string;
  agent: string;
  promptName: string;
  inputSummary: string;
  mockOutput: Record<string, unknown>;
  schema?: JsonSchema;
  simplifiedSchema?: JsonSchema;
  context?: Record<string, unknown>;
  knowledgeSummary?: string;
  prohibited?: string[];
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

function record(input: LlmCallInput, route: ModelRoute, data: Record<string, unknown>, schemaValid: boolean, retryCount: number, latencyMs: number) {
  const inputTokenCount = approxTokens(llmInputForLog(input));
  const outputTokenCount = approxTokens(data);
  const tokenCount = inputTokenCount + outputTokenCount;
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
    retryCount,
    latencyMs,
    inputTokenCount,
    outputTokenCount,
    tokenCount,
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
        retryCount,
        inputTokenCount,
        outputTokenCount,
        tokenCount,
        estimatedCost: estimateCost(tokenCount),
      },
    });
  }
}

function createDegradedGate(input: LlmCallInput, reason: string) {
  const id = `gate_llm_${input.agent}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  storage.createGate({
    id,
    cycleId: input.cycleId,
    type: "meaning",
    blocking: 0,
    title: `LLM 输出降级: ${input.agent}/${input.promptName}`,
    payload: JSON.stringify({ reason: redactSensitiveText(reason), promptVersion: promptVersion(input.promptName) }),
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
  const route = resolveModelRoute(input.agent, process.env);
  const provider = route.provider;

  if (provider !== "openai") {
    const schemaValid = validate(input.mockOutput, schema);
    record(safeInput, route, input.mockOutput, schemaValid, 0, Date.now() - started);
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
    record(safeInput, route, data, false, 0, Date.now() - started);
    return data;
  }

  const apiKey = openAiApiKey();
  if (!apiKey) {
    const data = { summary: `OpenAI disabled: missing OPENAI_API_KEY` };
    record(safeInput, route, data, false, 0, Date.now() - started);
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
        record(safeInput, route, data, true, attempt + transportRetries, Date.now() - started);
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
        record(safeInput, route, simpleData, true, 2 + transportRetries, Date.now() - started);
        return simpleData;
      }
      record(safeInput, route, simpleData, false, 2 + transportRetries, Date.now() - started);
      createDegradedGate(safeInput, `degraded to simplified schema after: ${lastError || "schema validation failed"}`);
      return simpleData;
    }
    lastError = "simplified schema validation failed";
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const simplified = { summary: `LLM degraded for ${input.agent}/${input.promptName}: ${lastError}` };
  record(safeInput, route, simplified, false, 3 + transportRetries, Date.now() - started);
  createDegradedGate(safeInput, lastError || "schema validation failed");
  return simplified;
}

function maxTransportRetries(): number {
  const raw = Number(process.env.OPENAI_MAX_RETRIES ?? 3);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 3) : 3;
}

function retryDelayMs(attempt: number): number {
  const base = Math.max(0, Number(process.env.OPENAI_RETRY_BASE_MS ?? 2_000));
  return Math.min(30_000, base * 2 ** Math.max(0, attempt - 1));
}

function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:429|5\d\d)\b/.test(message);
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
): Promise<{ data: Record<string, unknown>; retries: number }> {
  let retries = 0;
  let lastError: unknown;
  const maxRetries = maxTransportRetries();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return { data: await callOpenAI(input, schema, previousError, apiKey, model), retries };
    } catch (error) {
      lastError = error;
      if (!isRetryableLlmError(error) || attempt === maxRetries) break;
      retries += 1;
      await sleep(retryDelayMs(retries));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callOpenAI(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<Record<string, unknown>> {
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

async function callResponses(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<Record<string, unknown>> {
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
  return parseJsonObjectText(text, "OpenAI");
}

async function callChatCompletions(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string, model: string): Promise<Record<string, unknown>> {
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
  return parseJsonObjectText(text, "OpenAI-compatible chat");
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
