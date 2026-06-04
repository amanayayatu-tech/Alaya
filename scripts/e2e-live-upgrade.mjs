#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { inferGitHubTarget } from "./lib/github-target.mjs";

const root = process.cwd();
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function hasEnv(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function envOrFallback(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function resolveFile(envName, fallback) {
  const explicit = process.env[envName]?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (existsSync(fallback)) return fallback;
  return explicit || fallback;
}

function secretFileUsable(path) {
  if (!path || !existsSync(path)) return false;
  try {
    if (readFileSync(path, "utf8").trim().length === 0) return false;
    if (process.platform === "win32") return true;
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function secretFileHint(path) {
  if (!path || !existsSync(path)) return path;
  if (process.platform === "win32") return path;
  const mode = `0${(statSync(path).mode & 0o777).toString(8)}`;
  return `${path} (mode ${mode}; expected 0600)`;
}

const openaiKeyFile = resolveFile("OPENAI_API_KEY_FILE", "/private/tmp/alaya-minimax-key");
const githubTokenFile = resolveFile("GITHUB_TOKEN_FILE", "/private/tmp/alaya-github-token");
const githubTarget = inferGitHubTarget({ cwd: root });
const hasOpenaiKey = hasEnv("OPENAI_API_KEY") || secretFileUsable(openaiKeyFile);
const hasGithubToken = hasEnv("GITHUB_TOKEN") || hasEnv("ALAYA_GITHUB_TOKEN") ||
  secretFileUsable(githubTokenFile) ||
  (hasEnv("ALAYA_GITHUB_TOKEN_FILE") && secretFileUsable(process.env.ALAYA_GITHUB_TOKEN_FILE));
const hasGithubTarget = Boolean(githubTarget.owner && githubTarget.repo);

function missingPrereqs() {
  const missing = [];
  if (!hasOpenaiKey) missing.push(`OPENAI_API_KEY_FILE=${secretFileHint(openaiKeyFile)} or OPENAI_API_KEY`);
  if (!hasGithubTarget) missing.push("ALAYA_E2E_GITHUB_OWNER/ALAYA_E2E_GITHUB_REPO or a GitHub origin remote");
  if (!hasGithubToken) missing.push(`GITHUB_TOKEN_FILE=${secretFileHint(githubTokenFile)} or GITHUB_TOKEN/ALAYA_GITHUB_TOKEN`);
  return missing;
}

function printPrereqHelp(missing) {
  console.error("Live Alaya upgrade E2E cannot run because local-only prerequisites are missing:");
  for (const item of missing) console.error(`  - ${item}`);
  console.error("");
  console.error("Expected local-only setup, without writing secrets to code or Git:");
  console.error("  GitHub owner/repo are inferred from Git remote origin; override with ALAYA_E2E_GITHUB_OWNER/REPO if needed.");
  console.error("  OPENAI_API_KEY_FILE=/private/tmp/alaya-minimax-key \\");
  console.error("  OPENAI_BASE_URL=https://api.minimax.io/openai \\");
  console.error("  OPENAI_MODEL=MiniMax-M3 \\");
  console.error("  GITHUB_TOKEN_FILE=/private/tmp/alaya-github-token \\");
  console.error("  npm run e2e:live");
  if (githubTarget.owner && githubTarget.repo) {
    console.error(`Detected GitHub target from ${githubTarget.source}: ${githubTarget.owner}/${githubTarget.repo}`);
  }
}

function runCommand(label, args, env) {
  return new Promise((resolve, reject) => {
    console.error(`\n[${label}] npm ${args.join(" ")}`);
    const child = spawn(npmCmd, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

function findOpenPort(preferred) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: preferred }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : preferred;
      server.close(() => resolve(port));
    });
  });
}

async function waitForApp(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.ok) return;
      lastError = new Error(`GET /api/projects ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Alaya app did not become ready at ${baseUrl}: ${lastError?.message ?? "timeout"}`);
}

function startApp(env, port) {
  const child = spawn(npmCmd, ["--prefix", "alaya-app", "run", "dev"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[app] exited with code ${code}`);
    } else if (signal) {
      console.error(`[app] exited by signal ${signal}`);
    }
  });
  console.error(`[app] starting on 127.0.0.1:${port}`);
  return child;
}

function stopApp(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  const missing = missingPrereqs();
  if (missing.length > 0) {
    printPrereqHelp(missing);
    process.exit(2);
  }

  const openaiBaseUrl = process.env.OPENAI_BASE_URL ?? "https://api.minimax.io/openai";
  const openaiModel = process.env.OPENAI_MODEL ?? "MiniMax-M3";
  const port = Number(process.env.ALAYA_LIVE_E2E_PORT ?? await findOpenPort(5131));
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = process.env.ALAYA_LIVE_E2E_DB_PATH ?? join(tmpdir(), `alaya-live-e2e-${Date.now().toString(36)}.db`);
  const appLlmProvider = process.env.ALAYA_LIVE_APP_LLM_PROVIDER ?? "openai";

  const commonEnv = {
    ...process.env,
    OPENAI_API_KEY_FILE: envOrFallback("OPENAI_API_KEY_FILE", openaiKeyFile),
    OPENAI_BASE_URL: openaiBaseUrl,
    OPENAI_MODEL: openaiModel,
    GITHUB_TOKEN_FILE: envOrFallback("GITHUB_TOKEN_FILE", githubTokenFile),
    ALAYA_E2E_GITHUB_OWNER: githubTarget.owner,
    ALAYA_E2E_GITHUB_REPO: githubTarget.repo,
  };

  console.error("Live Alaya upgrade E2E starting with redacted local-only configuration:");
  console.error(JSON.stringify({
    openaiBaseUrl,
    openaiModel,
    openaiKeyFile: commonEnv.OPENAI_API_KEY_FILE,
    githubOwner: commonEnv.ALAYA_E2E_GITHUB_OWNER,
    githubRepo: commonEnv.ALAYA_E2E_GITHUB_REPO,
    githubTargetSource: githubTarget.source,
    githubTokenFile: commonEnv.GITHUB_TOKEN_FILE,
    appLlmProvider,
    baseUrl,
    dbPath,
  }, null, 2));

  await runCommand("real LLM provider preflight", ["run", "e2e:llm"], commonEnv);
  await runCommand("real LLM 4-cycle flywheel", ["run", "e2e:llm-flywheel"], commonEnv);

  const appEnv = {
    ...commonEnv,
    PORT: String(port),
    HOST: "127.0.0.1",
    ALAYA_DB_PATH: dbPath,
    ALAYA_LLM_PROVIDER: appLlmProvider,
    ALAYA_SCHEDULER: "true",
    ALAYA_SCHEDULER_INTERVAL_MS: process.env.ALAYA_SCHEDULER_INTERVAL_MS ?? "500",
    ALAYA_SENSOR_FEEDBACK_WINDOW_MS: process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS ?? "1000",
  };

  const app = startApp(appEnv, port);
  try {
    await waitForApp(baseUrl, Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 90_000));
    await runCommand("UI onboarding first cycle", ["run", "e2e:ui-onboarding"], {
      ...commonEnv,
      ALAYA_E2E_BASE_URL: baseUrl,
      ALAYA_E2E_TIMEOUT_MS: process.env.ALAYA_E2E_TIMEOUT_MS ?? "120000",
    });
    await runCommand("autonomous scheduler with form feedback", ["run", "e2e:scheduler"], {
      ...commonEnv,
      ALAYA_E2E_BASE_URL: baseUrl,
      ALAYA_E2E_TIMEOUT_MS: process.env.ALAYA_E2E_TIMEOUT_MS ?? "120000",
    });
    await runCommand("real GitHub autonomous sensor", ["run", "e2e:github-autonomous"], {
      ...commonEnv,
      ALAYA_E2E_BASE_URL: baseUrl,
      ALAYA_E2E_TIMEOUT_MS: process.env.ALAYA_E2E_TIMEOUT_MS ?? "120000",
    });
  } finally {
    await stopApp(app);
  }

  await runCommand("final completion audit", ["run", "audit:upgrade"], {
    ...commonEnv,
    ALAYA_AUDIT_REQUIRE_COMPLETE: "true",
  });

  console.log(JSON.stringify({
    ok: true,
    provider: appLlmProvider,
    baseUrl,
    dbPath,
    note: "Real LLM preflight, real LLM flywheel, UI onboarding, autonomous scheduler, real GitHub autonomous Sensor E2E, and final completion audit all completed.",
  }, null, 2));
}

main().catch((error) => {
  console.error(`Live Alaya upgrade E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
