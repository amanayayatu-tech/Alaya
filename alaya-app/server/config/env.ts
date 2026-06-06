export type RunMode = "development" | "test" | "shadow" | "staging" | "production";

export interface EnvValidationResult {
  mode: RunMode;
  errors: string[];
  warnings: string[];
}

const RUN_MODES = new Set<RunMode>(["development", "test", "shadow", "staging", "production"]);
const TEST_VALUE_RE = /^(|test|test-secret|changeme|change-me|demo|demo-key|example|placeholder|dummy|fake|none|null)$/i;
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|private[_-]?key|webhook[_-]?secret|database_url)$/i;

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

  if (mode === "production" && env.ALAYA_AUTO_SEED_DEMO !== "false") {
    errors.push("ALAYA_AUTO_SEED_DEMO=false is required in production");
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
