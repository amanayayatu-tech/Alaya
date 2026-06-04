import { storage, now } from "./storage";
import { readFileSync } from "node:fs";

const DEFAULT_OPENAI_API_KEY_FILE = "/private/tmp/alaya-minimax-key";

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

function sanitizeInput(input: LlmCallInput): LlmCallInput {
  return {
    ...input,
    inputSummary: redactSensitiveText(input.inputSummary),
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
  return readSecretFile(process.env.OPENAI_API_KEY_FILE) || readSecretFile(DEFAULT_OPENAI_API_KEY_FILE);
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

function record(input: LlmCallInput, data: Record<string, unknown>, schemaValid: boolean, retryCount: number, latencyMs: number, tokenCount: number) {
  storage.recordLlmCall({
    cycleId: input.cycleId,
    agent: input.agent,
    promptVersion: promptVersion(input.promptName),
    inputSummary: summarize({
      input: input.inputSummary,
      context: input.context ?? {},
      knowledgeSummary: input.knowledgeSummary ?? "",
      prohibited: input.prohibited ?? [],
    }),
    outputSummary: summarize(sanitizeValue(data)),
    schemaValid: schemaValid ? 1 : 0,
    retryCount,
    latencyMs,
    tokenCount,
    estimatedCost: estimateCost(tokenCount),
    ts: now(),
  });
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
  const provider = process.env.ALAYA_LLM_PROVIDER ?? "mock";

  if (provider !== "openai") {
    const schemaValid = validate(input.mockOutput, schema);
    const tokenCount = approxTokens({ input: safeInput, output: input.mockOutput });
    record(safeInput, input.mockOutput, schemaValid, 0, Date.now() - started, tokenCount);
    if (!schemaValid) createDegradedGate(safeInput, "mock output failed schema validation");
    return input.mockOutput;
  }

  const apiKey = openAiApiKey();
  if (!apiKey) {
    const data = { summary: `OpenAI disabled: missing OPENAI_API_KEY` };
    record(safeInput, data, false, 0, Date.now() - started, approxTokens({ input: safeInput, data }));
    createDegradedGate(safeInput, "OPENAI_API_KEY is not set");
    return data;
  }

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await callOpenAI(safeInput, schema, redactSensitiveText(lastError), apiKey);
      const errors = validationErrors(data, schema);
      if (errors.length === 0) {
        record(safeInput, data, true, attempt, Date.now() - started, approxTokens({ input: safeInput, data }));
        return data;
      }
      lastError = `schema validation failed: ${errors.join("; ")}. Include every required key; use [] for empty arrays.`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    const simpleSchema = input.simplifiedSchema ?? DEFAULT_SIMPLIFIED_SCHEMA;
    const simpleData = await callOpenAI(
      safeInput,
      simpleSchema,
      `response failed JSON schema validation; return simplified JSON summary only. ${redactSensitiveText(lastError)}`,
      apiKey,
    );
    if (validate(simpleData, simpleSchema)) {
      record(safeInput, simpleData, false, 2, Date.now() - started, approxTokens({ input: safeInput, simpleData }));
      createDegradedGate(safeInput, `degraded to simplified schema after: ${lastError || "schema validation failed"}`);
      return simpleData;
    }
    lastError = "simplified schema validation failed";
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const simplified = { summary: `LLM degraded for ${input.agent}/${input.promptName}: ${lastError}` };
  record(safeInput, simplified, false, 3, Date.now() - started, approxTokens({ input: safeInput, simplified }));
  createDegradedGate(safeInput, lastError || "schema validation failed");
  return simplified;
}

async function callOpenAI(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string): Promise<Record<string, unknown>> {
  const mode = resolveOpenAIApiMode();
  if (mode === "chat") return callChatCompletions(input, schema, previousError, apiKey);
  return callResponses(input, schema, previousError, apiKey);
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

async function callResponses(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string): Promise<Record<string, unknown>> {
  const endpoint = process.env.OPENAI_RESPONSES_ENDPOINT ?? "https://api.openai.com/v1/responses";
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      instructions: "You are an Alaya agent. Return only JSON matching the provided schema.",
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

async function callChatCompletions(input: LlmCallInput, schema: JsonSchema, previousError: string, apiKey: string): Promise<Record<string, unknown>> {
  const endpoint = process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT
    ?? chatCompletionsEndpoint(process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are an Alaya agent. Return only JSON matching the supplied schema.",
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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // Fall through to the readable error below.
      }
    }
    throw new Error(`${source} response was not parseable JSON: ${text.slice(0, 300)}`);
  }
}
