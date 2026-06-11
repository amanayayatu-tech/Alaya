import { SENSOR_RECURRING_COUNT_THRESHOLD, SENSOR_STRUCTURAL_COUNT_THRESHOLD } from "alaya-core/src/core/sensor_filter.js";

export type RunMode = "development" | "test" | "shadow" | "staging" | "production";

export interface EnvValidationResult {
  mode: RunMode;
  errors: string[];
  warnings: string[];
}

export interface ReviewWindowConfig {
  start: string;
  end: string;
  label: string;
  startMinutes: number;
  endMinutes: number;
}

const RUN_MODES = new Set<RunMode>(["development", "test", "shadow", "staging", "production"]);
const TEST_VALUE_RE = /^(|test|test-secret|changeme|change-me|demo|demo-key|example|placeholder|dummy|fake|none|null)$/i;
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|private[_-]?key|webhook[_-]?secret|database_url)$/i;
const DEFAULT_REVIEW_WINDOWS = "15:30-16:00";
const DEFAULT_IMMEDIATE_RISK_LEVELS = "destructive,financial,compliance_sensitive";
const REVIEW_WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function isRunMode(value: string): value is RunMode {
  return RUN_MODES.has(value as RunMode);
}

export function runModeFromEnv(env: NodeJS.ProcessEnv = process.env): RunMode {
  const explicit = env.ALAYA_MODE?.trim().toLowerCase();
  if (explicit && isRunMode(explicit)) return explicit;
  if (env.NODE_ENV === "test") return "test";
  if (env.NODE_ENV === "production") return "production";
  return "development";
}

export function isProductionLikeMode(mode: RunMode): boolean {
  return mode === "production" || mode === "staging";
}

export function isLongRunMode(mode: RunMode): boolean {
  return mode === "shadow" || mode === "staging" || mode === "production";
}

export function boolEnv(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "allow", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "deny", "disabled"].includes(normalized)) return false;
  return undefined;
}

export function capabilityEnvName(capability: string): string {
  return `ALAYA_CAP_${capability.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function minutesFor(hour: string, minute: string): number {
  return Number(hour) * 60 + Number(minute);
}

export function parseReviewWindows(value: string | undefined): ReviewWindowConfig[] {
  const raw = value?.trim() || DEFAULT_REVIEW_WINDOWS;
  return raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = REVIEW_WINDOW_RE.exec(item);
    if (!match) throw new Error(`ALAYA_REVIEW_WINDOWS entry must be HH:MM-HH:MM; received ${item}`);
    const startMinutes = minutesFor(match[1], match[2]);
    const endMinutes = minutesFor(match[3], match[4]);
    if (endMinutes <= startMinutes) {
      throw new Error(`ALAYA_REVIEW_WINDOWS entry end must be after start; received ${item}`);
    }
    return {
      start: `${match[1]}:${match[2]}`,
      end: `${match[3]}:${match[4]}`,
      label: item,
      startMinutes,
      endMinutes,
    };
  });
}

export function reviewWindowsFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewWindowConfig[] {
  return parseReviewWindows(env.ALAYA_REVIEW_WINDOWS);
}

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function reviewTimezoneFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ALAYA_REVIEW_TIMEZONE?.trim();
  return configured || "Asia/Shanghai";
}

function parseNonNegativeIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function applyGraceSecondsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonNegativeIntegerEnv(env, "ALAYA_APPLY_GRACE_SECONDS", 60);
}

export function applyStaggerSecondsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonNegativeIntegerEnv(env, "ALAYA_APPLY_STAGGER_SECONDS", 120);
}

export function gateEscalationMissedWindowsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALAYA_GATE_ESCALATION_MISSED_WINDOWS?.trim();
  if (!raw) return 2;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}

export function speculativeDraftingFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.ALAYA_SPECULATIVE_DRAFTING) ?? true;
}

export function speculativeBudgetRatioFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALAYA_SPECULATIVE_BUDGET_RATIO?.trim();
  if (!raw) return 0.5;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}

export function immediateRiskLevelsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.ALAYA_IMMEDIATE_RISK_LEVELS?.trim() || DEFAULT_IMMEDIATE_RISK_LEVELS;
  return new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function sensorStructuralThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALAYA_SENSOR_STRUCTURAL_THRESHOLD?.trim();
  if (!raw) return SENSOR_STRUCTURAL_COUNT_THRESHOLD;
  const value = Number(raw);
  return Number.isInteger(value) && value >= SENSOR_RECURRING_COUNT_THRESHOLD
    ? value
    : SENSOR_STRUCTURAL_COUNT_THRESHOLD;
}

function externalNotificationRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ALAYA_CAP_EXTERNAL_NOTIFICATION?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "dry_run" || raw === "dry-run" || raw === "audit";
}

function envHasUsableSecret(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  return !!value && !TEST_VALUE_RE.test(value);
}

function isPlaceholderSecret(value: string): boolean {
  if (TEST_VALUE_RE.test(value.trim())) return true;
  if (/^(sk|ghp|github_pat|xox[abprs])[-_]?test/i.test(value.trim())) return true;
  return false;
}

function validateSecretValues(env: NodeJS.ProcessEnv, mode: RunMode): string[] {
  if (!isProductionLikeMode(mode)) return [];
  const errors: string[] = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (!SECRET_KEY_RE.test(key) || rawValue == null) continue;
    const value = rawValue.trim();
    if (isPlaceholderSecret(value)) {
      errors.push(`${key} uses a placeholder or test value in ${mode} mode`);
    }
  }
  return errors;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const mode = runModeFromEnv(env);
  const errors: string[] = [];
  const warnings: string[] = [];

  const explicitMode = env.ALAYA_MODE?.trim().toLowerCase();
  if (explicitMode && !isRunMode(explicitMode)) {
    errors.push(`ALAYA_MODE must be one of development,test,shadow,staging,production; received ${explicitMode}`);
  }

  const port = Number(env.PORT ?? 5000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push("PORT must be an integer between 1 and 65535");

  try {
    const windows = parseReviewWindows(env.ALAYA_REVIEW_WINDOWS);
    if (windows.length === 0) errors.push("ALAYA_REVIEW_WINDOWS must contain at least one HH:MM-HH:MM entry");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const reviewTimezone = env.ALAYA_REVIEW_TIMEZONE?.trim();
  if (isLongRunMode(mode) && !reviewTimezone) {
    errors.push("ALAYA_REVIEW_TIMEZONE is required in shadow/staging/production");
  }
  if (reviewTimezone && !isValidIanaTimezone(reviewTimezone)) {
    errors.push(`ALAYA_REVIEW_TIMEZONE must be a valid IANA time zone; received ${reviewTimezone}`);
  }

  for (const [key, fallback] of [
    ["ALAYA_APPLY_GRACE_SECONDS", 60],
    ["ALAYA_APPLY_STAGGER_SECONDS", 120],
  ] as const) {
    const raw = env[key]?.trim();
    if (raw) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) errors.push(`${key} must be an integer >= 0`);
    }
    parseNonNegativeIntegerEnv(env, key, fallback);
  }

  const missedWindowsRaw = env.ALAYA_GATE_ESCALATION_MISSED_WINDOWS?.trim();
  if (missedWindowsRaw) {
    const value = Number(missedWindowsRaw);
    if (!Number.isInteger(value) || value < 1) errors.push("ALAYA_GATE_ESCALATION_MISSED_WINDOWS must be an integer >= 1");
  }

  if (env.ALAYA_SPECULATIVE_DRAFTING?.trim() && boolEnv(env.ALAYA_SPECULATIVE_DRAFTING) == null) {
    errors.push("ALAYA_SPECULATIVE_DRAFTING must be boolean");
  }

  const speculativeBudgetRaw = env.ALAYA_SPECULATIVE_BUDGET_RATIO?.trim();
  if (speculativeBudgetRaw) {
    const value = Number(speculativeBudgetRaw);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      errors.push("ALAYA_SPECULATIVE_BUDGET_RATIO must be a number in (0,1]");
    }
  }

  if (env.ALAYA_IMMEDIATE_RISK_LEVELS?.trim() === "") {
    errors.push("ALAYA_IMMEDIATE_RISK_LEVELS must not be empty when provided");
  }

  const sensorStructuralThresholdRaw = env.ALAYA_SENSOR_STRUCTURAL_THRESHOLD?.trim();
  if (sensorStructuralThresholdRaw) {
    const value = Number(sensorStructuralThresholdRaw);
    if (!Number.isInteger(value) || value < SENSOR_RECURRING_COUNT_THRESHOLD) {
      errors.push(`ALAYA_SENSOR_STRUCTURAL_THRESHOLD must be an integer >= ${SENSOR_RECURRING_COUNT_THRESHOLD}`);
    }
  }

  if (externalNotificationRequested(env)) {
    const telegramUserId = env.ALAYA_TELEGRAM_USER_ID?.trim();
    if (!telegramUserId || !/^\d+$/.test(telegramUserId)) {
      errors.push("ALAYA_TELEGRAM_USER_ID must be a numeric user id when external notification is enabled");
    }
  }

  if (isLongRunMode(mode) && !env.ALAYA_API_KEY?.trim()) {
    errors.push("ALAYA_API_KEY is required in shadow/staging/production");
  }

  if (isProductionLikeMode(mode)) {
    if (!env.ALAYA_DB_PATH?.trim()) errors.push("ALAYA_DB_PATH is required in staging/production");
    if (env.ALAYA_LLM_PROVIDER === "openai") {
      const hasKey = envHasUsableSecret(env, "OPENAI_API_KEY") || !!env.OPENAI_API_KEY_FILE?.trim();
      if (!hasKey) errors.push("OPENAI_API_KEY or OPENAI_API_KEY_FILE is required when ALAYA_LLM_PROVIDER=openai in staging/production");
    }
    if (boolEnv(env[capabilityEnvName("shell_execution")]) !== true) {
      warnings.push("shell execution is disabled; set ALAYA_CAP_SHELL_EXECUTION=true only for a reviewed maintenance window");
    }
    if (boolEnv(env[capabilityEnvName("scheduler_loop")]) !== true) {
      warnings.push("scheduler loop is disabled by default in staging/production until ALAYA_CAP_SCHEDULER_LOOP=true");
    }
  }

  if (isLongRunMode(mode) && env.ALAYA_AUTO_SEED_DEMO !== "false") {
    errors.push("ALAYA_AUTO_SEED_DEMO=false is required in shadow/staging/production");
  }

  if (mode === "production" && env.ALAYA_LLM_PROVIDER !== "mock" && boolEnv(env[capabilityEnvName("llm_call")]) !== true) {
    errors.push("ALAYA_CAP_LLM_CALL=true is required before production can call a real LLM provider");
  }

  errors.push(...validateSecretValues(env, mode));

  return { mode, errors, warnings };
}

export function assertEnvValid(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const result = validateEnv(env);
  if (result.errors.length > 0) {
    throw new Error(`Alaya environment validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}

export function isSchemaMigrationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = runModeFromEnv(env);
  if (!isLongRunMode(mode)) return true;
  return boolEnv(env[capabilityEnvName("database_migration")]) === true;
}
