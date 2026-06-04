import type { ModelRoute } from "../core/types.js";

type EnvMap = Record<string, string | undefined>;

type RouteConfig = Partial<Record<string, {
  provider?: string;
  model?: string;
}>>;

const DEFAULT_ROLE = "default";

function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") || DEFAULT_ROLE;
}

function parseRoutingJson(raw: string | undefined): RouteConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: RouteConfig = {};
    for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      out[normalizeRole(role)] = {
        provider: typeof item.provider === "string" ? item.provider : undefined,
        model: typeof item.model === "string" ? item.model : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function roleEnv(env: EnvMap, role: string, key: "MODEL" | "PROVIDER"): string | undefined {
  const upper = normalizeRole(role).toUpperCase();
  return env[`ALAYA_${upper}_${key}`] || env[`ALAYA_${key}_${upper}`];
}

function defaultProvider(env: EnvMap): string {
  return env.ALAYA_LLM_PROVIDER?.trim() || "mock";
}

function defaultModel(env: EnvMap, provider: string): string {
  if (provider === "mock") return "mock";
  return env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
}

export function resolveModelRoute(role: string, env: EnvMap = {}): ModelRoute {
  const normalizedRole = normalizeRole(role);
  const routing = parseRoutingJson(env.ALAYA_MODEL_ROUTING_JSON);
  const jsonRoute = routing[normalizedRole] ?? routing[DEFAULT_ROLE];
  const provider = roleEnv(env, normalizedRole, "PROVIDER")?.trim() ||
    jsonRoute?.provider?.trim() ||
    defaultProvider(env);
  const model = roleEnv(env, normalizedRole, "MODEL")?.trim() ||
    jsonRoute?.model?.trim() ||
    defaultModel(env, provider);

  let routeReason = "default";
  if (roleEnv(env, normalizedRole, "MODEL") || roleEnv(env, normalizedRole, "PROVIDER")) {
    routeReason = "role_env";
  } else if (jsonRoute) {
    routeReason = routing[normalizedRole] ? "routing_json_role" : "routing_json_default";
  } else if (env.OPENAI_MODEL || env.ALAYA_LLM_PROVIDER) {
    routeReason = "global_env";
  }

  return {
    role: normalizedRole,
    provider,
    model,
    routeReason,
  };
}
