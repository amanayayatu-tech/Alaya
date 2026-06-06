/**
 * LLM Provider 抽象 (PRD 5、16)。
 *
 * Layer 1 升级要求:
 * - Mock 和真实 OpenAI 都走同一套结构化上下文与 JSON Schema 契约。
 * - 每次调用必须有 prompt_version。
 * - 输出必须 schema validate。
 * - 失败按 retry -> simplified schema -> non-blocking human gate 降级。
 * - 调用日志包含 prompt_version / input_summary / output_summary /
 *   schema_valid / retry_count / latency_ms / token_count / estimated_cost。
 */
import { readFileSync } from "node:fs";

export type JsonSchema = {
  type: "object";
  required?: string[];
  properties?: Record<string, JsonSchema | { type: string; items?: JsonSchema }>;
  additionalProperties?: boolean;
};

export interface AgentContext {
  role: string;
  task: string;
  promptVersion: string;
  context: Record<string, unknown>;
  schema: JsonSchema;
  simplifiedSchema?: JsonSchema;
  knowledgeSummary?: string;
  prohibited?: string[];
  mockData?: Record<string, unknown>;
}

export interface LLMCallLog {
  provider: string;
  agent: string;
  promptVersion: string;
  inputSummary: string;
  outputSummary: string;
  schemaValid: boolean;
  retryCount: number;
  latencyMs: number;
  tokenCount: number;
  estimatedCost: number;
  ts: string;
}

export interface LLMResponse {
  schemaValid: boolean;
  retryCount: number;
  data: Record<string, unknown>;
  log: LLMCallLog;
  degradedToHumanGate: boolean;
  errorMessage?: string;
}

export interface LLMProvider {
  name: string;
  call(request: AgentContext): Promise<LLMResponse>;
}

const DEFAULT_SIMPLIFIED_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
  },
};

function now() {
  return new Date().toISOString();
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

function redactSensitiveText(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-phone]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:ghp|github_pat|sk|xox[abprs])_[A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]{8,}/gi, "$1=[redacted-secret]");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeValue(item)]),
    );
  }
  return value;
}

function sanitizeAgentContext(request: AgentContext): AgentContext {
  return {
    ...request,
    context: sanitizeValue(request.context) as Record<string, unknown>,
    knowledgeSummary: request.knowledgeSummary ? redactSensitiveText(request.knowledgeSummary) : request.knowledgeSummary,
    prohibited: request.prohibited?.map(redactSensitiveText),
    mockData: request.mockData ? sanitizeValue(request.mockData) as Record<string, unknown> : request.mockData,
  };
}

function countTokensApprox(input: string): number {
  return Math.max(1, Math.ceil(input.length / 4));
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const lower = model.toLowerCase();
  const inputPerMillion = lower.includes("gpt-4") || lower.includes("o3") ? 2.5 : 0.15;
  const outputPerMillion = lower.includes("gpt-4") || lower.includes("o3") ? 10 : 0.6;
  return +(((inputTokens * inputPerMillion) + (outputTokens * outputPerMillion)) / 1_000_000).toFixed(6);
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "null") return value === null;
  return typeof value === expected;
}

export function validateJsonSchema(data: unknown, schema: JsonSchema): boolean {
  return jsonSchemaErrors(data, schema).length === 0;
}

function jsonSchemaErrors(data: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (!typeMatches(data, schema.type)) return [`${path} should be ${schema.type}`];
  if (schema.type !== "object") return errors;
  const obj = data as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) errors.push(`${path}.${key} is required`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue;
    if ("type" in child && child.type === "array") {
      if (!Array.isArray(obj[key])) errors.push(`${path}.${key} should be array`);
      continue;
    }
    errors.push(...jsonSchemaErrors(obj[key], child as JsonSchema, `${path}.${key}`));
  }
  return errors;
}

function makeLog(
  provider: string,
  request: AgentContext,
  data: Record<string, unknown>,
  schemaValid: boolean,
  retryCount: number,
  latencyMs: number,
  tokenCount: number,
  estimatedCost: number,
): LLMCallLog {
  const safeRequest = sanitizeAgentContext(request);
  return {
    provider,
    agent: safeRequest.role,
    promptVersion: safeRequest.promptVersion,
    inputSummary: summarize({ task: safeRequest.task, context: safeRequest.context }),
    outputSummary: summarize(sanitizeValue(data)),
    schemaValid,
    retryCount,
    latencyMs,
    tokenCount,
    estimatedCost,
    ts: now(),
  };
}

/**
 * 确定性 Mock:由调用方在 mockData 注入语义输出,但 mock 仍执行 schema 校验和日志。
 */
export class MockLLM implements LLMProvider {
  name = "mock";

  async call(request: AgentContext): Promise<LLMResponse> {
    const safeRequest = sanitizeAgentContext(request);
    const started = Date.now();
    const data = request.mockData ?? {
      summary: `${request.role}:${request.task}`,
      note: "mock structured output",
    };
    const schemaValid = validateJsonSchema(data, request.schema);
    const latencyMs = Date.now() - started;
    const text = stableStringify({ request: safeRequest, data: sanitizeValue(data) });
    const tokenCount = countTokensApprox(text);
    return {
      schemaValid,
      retryCount: 0,
      data,
      log: makeLog(this.name, safeRequest, data, schemaValid, 0, latencyMs, tokenCount, 0),
      degradedToHumanGate: !schemaValid,
      errorMessage: schemaValid ? undefined : "mock output failed schema validation",
    };
  }
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  baseUrl?: string;
  apiMode?: "responses" | "chat";
  maxRetries?: number;
  temperature?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

function readSecretFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function resolveOpenAIApiKey(explicit?: string): string {
  if (explicit !== undefined) return explicit.trim();
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  return readSecretFile(process.env.OPENAI_API_KEY_FILE);
}

/**
 * OpenAI-compatible adapter.
 * Defaults to Responses API, and switches to Chat Completions when OPENAI_API_MODE=chat
 * or OPENAI_BASE_URL is provided for providers such as MiniMax.
 */
export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private endpoint: string;
  private apiMode: "responses" | "chat";
  private maxRetries: number;
  private temperature: number;
  private timeoutMs: number;
  private maxOutputTokens: number;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = resolveOpenAIApiKey(options.apiKey);
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.apiMode = resolveApiMode(options);
    this.endpoint = resolveEndpoint(this.apiMode, options);
    this.maxRetries = options.maxRetries ?? 1;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = resolveRequestTimeoutMs(options.timeoutMs);
    this.maxOutputTokens = resolveMaxOutputTokens(options.maxOutputTokens);
  }

  async call(request: AgentContext): Promise<LLMResponse> {
    const safeRequest = sanitizeAgentContext(request);
    if (!this.apiKey) {
      return this.degradedResponse(safeRequest, "OPENAI_API_KEY is not set", 0, Date.now());
    }

    const started = Date.now();
    let lastError = "";
    let retryCount = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      retryCount = attempt;
      try {
        const data = await this.callStructuredApi(safeRequest, safeRequest.schema, redactSensitiveText(lastError));
        const schemaErrors = jsonSchemaErrors(data, request.schema);
        if (schemaErrors.length === 0) {
          const usage = (data.__usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          delete data.__usage;
          const latencyMs = Date.now() - started;
          const inputTokens = usage.inputTokens ?? countTokensApprox(stableStringify(safeRequest));
          const outputTokens = usage.outputTokens ?? countTokensApprox(stableStringify(sanitizeValue(data)));
          return {
            schemaValid: true,
            retryCount,
            data,
            log: makeLog(
              this.name,
              safeRequest,
              data,
              true,
              retryCount,
              latencyMs,
              usage.totalTokens ?? inputTokens + outputTokens,
              estimateCost(this.model, inputTokens, outputTokens),
            ),
            degradedToHumanGate: false,
          };
        }
        lastError = `response failed JSON schema validation: ${schemaErrors.join("; ")}. Include every required key; use [] for empty arrays.`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    try {
      const simpleSchema = safeRequest.simplifiedSchema ?? DEFAULT_SIMPLIFIED_SCHEMA;
      const simpleData = await this.callStructuredApi(safeRequest, simpleSchema, redactSensitiveText(lastError));
      const simpleValid = validateJsonSchema(simpleData, simpleSchema);
      if (simpleValid) {
        const usage = (simpleData.__usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        const originalSchemaErrors = jsonSchemaErrors(simpleData, request.schema);
        const latencyMs = Date.now() - started;
        delete simpleData.__usage;
        if (originalSchemaErrors.length === 0) {
          const inputTokens = usage.inputTokens ?? countTokensApprox(stableStringify(safeRequest));
          const outputTokens = usage.outputTokens ?? countTokensApprox(stableStringify(sanitizeValue(simpleData)));
          return {
            schemaValid: true,
            retryCount: retryCount + 1,
            data: simpleData,
            log: makeLog(
              this.name,
              safeRequest,
              simpleData,
              true,
              retryCount + 1,
              latencyMs,
              usage.totalTokens ?? inputTokens + outputTokens,
              estimateCost(this.model, inputTokens, outputTokens),
            ),
            degradedToHumanGate: false,
          };
        }
        return {
          schemaValid: false,
          retryCount: retryCount + 1,
          data: simpleData,
          log: makeLog(
            this.name,
            safeRequest,
            simpleData,
            false,
            retryCount + 1,
            latencyMs,
            countTokensApprox(stableStringify({ request: safeRequest, simpleData: sanitizeValue(simpleData) })),
            estimateCost(this.model, countTokensApprox(stableStringify(safeRequest)), countTokensApprox(stableStringify(sanitizeValue(simpleData)))),
          ),
          degradedToHumanGate: true,
          errorMessage: `degraded to simplified schema after: ${redactSensitiveText(lastError)}`,
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    return this.degradedResponse(safeRequest, lastError, retryCount + 2, started);
  }

  private async callStructuredApi(
    request: AgentContext,
    schema: JsonSchema,
    previousError: string,
  ): Promise<Record<string, unknown>> {
    if (this.apiMode === "chat") return this.callChatCompletionsApi(request, schema, previousError);
    return this.callResponsesApi(request, schema, previousError);
  }

  private degradedResponse(
    request: AgentContext,
    errorMessage: string,
    retryCount: number,
    started: number,
  ): LLMResponse {
    const safeErrorMessage = redactSensitiveText(errorMessage);
    const data = {
      summary: `LLM call failed for ${request.role}:${request.task}`,
      human_gate_candidate: {
        type: "meaning",
        blocking: false,
        reason: safeErrorMessage,
      },
    };
    const latencyMs = Date.now() - started;
    const tokenCount = countTokensApprox(stableStringify({ request, data: sanitizeValue(data) }));
    return {
      schemaValid: false,
      retryCount,
      data,
      log: makeLog(
        this.name,
        request,
        data,
        false,
        retryCount,
        latencyMs,
        tokenCount,
        estimateCost(this.model, tokenCount, 0),
      ),
      degradedToHumanGate: true,
      errorMessage: safeErrorMessage,
    };
  }

  private async callResponsesApi(
    request: AgentContext,
    schema: JsonSchema,
    previousError: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchWithTimeout(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        max_output_tokens: this.maxOutputTokens,
        instructions:
          "You are an Alaya agent. Return concise JSON only. " +
          "Match the supplied schema exactly, using [] for empty arrays. " +
          "If draft_output already satisfies the schema, copy its key names exactly and adapt content only when evidence requires it. " +
          "Do not decide knowledge confidence; provide evidence and summaries only.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: stableStringify({
                  role: request.role,
                  task: request.task,
                  prompt_version: request.promptVersion,
                  knowledge_summary: request.knowledgeSummary ?? "",
                  prohibited: request.prohibited ?? [],
                  context: request.context,
                  draft_output: request.mockData ?? {},
                  previous_error: previousError,
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: request.promptVersion.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "alaya_agent_output",
            schema,
            strict: false,
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI ${response.status}: ${body.slice(0, 500)}`);
    }

    const json = await response.json() as any;
    const text = extractOutputText(json);
    const parsed = parseJsonObjectText(text, "OpenAI");

    parsed.__usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
      totalTokens: json.usage?.total_tokens,
    };
    return parsed;
  }

  private async callChatCompletionsApi(
    request: AgentContext,
    schema: JsonSchema,
    previousError: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchWithTimeout(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxOutputTokens,
        response_format: { type: "json_object" },
        ...providerChatExtras(this.model, this.endpoint),
        messages: [
          {
            role: "system",
            content:
              "You are an Alaya agent. Return concise JSON only. " +
              "Match the supplied schema exactly, using [] for empty arrays. " +
              "If draft_output already satisfies the schema, copy its key names exactly and adapt content only when evidence requires it. " +
              "Do not decide knowledge confidence; provide evidence and summaries only.",
          },
          {
            role: "user",
            content: stableStringify({
              role: request.role,
              task: request.task,
              prompt_version: request.promptVersion,
              knowledge_summary: request.knowledgeSummary ?? "",
              prohibited: request.prohibited ?? [],
              context: request.context,
              draft_output: request.mockData ?? {},
              previous_error: previousError,
              output_schema: schema,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible chat ${response.status}: ${body.slice(0, 500)}`);
    }

    const json = await response.json() as any;
    const text = extractChatOutputText(json);
    const parsed = parseJsonObjectText(text, "OpenAI-compatible chat");

    parsed.__usage = {
      inputTokens: json.usage?.prompt_tokens ?? json.usage?.input_tokens,
      outputTokens: json.usage?.completion_tokens ?? json.usage?.output_tokens,
      totalTokens: json.usage?.total_tokens,
    };
    return parsed;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`OpenAI-compatible request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function resolveApiMode(options: OpenAIProviderOptions): "responses" | "chat" {
  const raw = options.apiMode ?? process.env.OPENAI_API_MODE ?? process.env.OPENAI_COMPAT_MODE;
  if (raw === "chat" || raw === "responses") return raw;
  if (options.baseUrl || process.env.OPENAI_BASE_URL || process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT) return "chat";
  return "responses";
}

function resolveEndpoint(mode: "responses" | "chat", options: OpenAIProviderOptions): string {
  if (mode === "responses") {
    return options.endpoint ?? process.env.OPENAI_RESPONSES_ENDPOINT ?? "https://api.openai.com/v1/responses";
  }
  return options.endpoint
    ?? process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT
    ?? chatCompletionsEndpoint(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
}

function resolveRequestTimeoutMs(explicit?: number): number {
  const raw = explicit ?? Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 90_000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 90_000;
}

function resolveMaxOutputTokens(explicit?: number): number {
  const raw = explicit ?? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 512);
  return Number.isFinite(raw) ? Math.max(64, Math.floor(raw)) : 512;
}

function providerChatExtras(model: string, endpoint: string): Record<string, unknown> {
  const target = `${model} ${endpoint}`.toLowerCase();
  if (!target.includes("minimax")) return {};
  const raw = (process.env.MINIMAX_THINKING ?? process.env.OPENAI_THINKING ?? "disabled").toLowerCase();
  const type = raw === "adaptive" ? "adaptive" : "disabled";
  return { thinking: { type } };
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

export function createLLMProvider(): LLMProvider {
  if (process.env.ALAYA_LLM_PROVIDER === "openai") return new OpenAIProvider();
  return new MockLLM();
}
