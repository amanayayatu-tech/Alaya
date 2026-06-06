import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inferGitHubTarget, parseGitHubRemoteUrl } from "../lib/github-target.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("parseGitHubRemoteUrl supports common GitHub remote forms", () => {
  assert.deepEqual(parseGitHubRemoteUrl("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
  assert.deepEqual(parseGitHubRemoteUrl("https://github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
  assert.deepEqual(parseGitHubRemoteUrl("ssh://git@github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
  assert.equal(parseGitHubRemoteUrl("https://example.com/owner/repo.git"), null);
});

test("inferGitHubTarget prefers env, then explicit remote, then git origin", () => {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-github-target-"));
  mkdirSync(join(tmp, ".git"));
  writeFileSync(join(tmp, ".git", "config"), [
    '[remote "origin"]',
    "  url = https://github.com/origin-owner/origin-repo.git",
    "",
  ].join("\n"));

  assert.deepEqual(inferGitHubTarget({
    cwd: tmp,
    env: { ALAYA_E2E_GITHUB_OWNER: "env-owner", ALAYA_E2E_GITHUB_REPO: "env-repo" },
  }), { owner: "env-owner", repo: "env-repo", source: "env" });

  assert.deepEqual(inferGitHubTarget({
    cwd: tmp,
    env: { ALAYA_E2E_GITHUB_REMOTE_URL: "git@github.com:remote-owner/remote-repo.git" },
  }), { owner: "remote-owner", repo: "remote-repo", source: "ALAYA_E2E_GITHUB_REMOTE_URL" });

  assert.deepEqual(inferGitHubTarget({ cwd: tmp, env: {} }), {
    owner: "origin-owner",
    repo: "origin-repo",
    source: "git remote origin",
  });
});

test("setup-local-secrets --check reports presence without printing secret values", () => {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-secret-check-"));
  const minimaxKeyFile = join(tmp, "minimax-key");
  const githubTokenFile = join(tmp, "github-token");
  writeFileSync(minimaxKeyFile, "sk-test-minimax-value-that-must-not-be-printed\n", { mode: 0o600 });
  writeFileSync(githubTokenFile, "ghp_test_github_value_that_must_not_be_printed\n", { mode: 0o600 });

  const result = spawnSync(process.execPath, ["scripts/setup-local-secrets.mjs", "--check"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY_FILE: minimaxKeyFile,
      GITHUB_TOKEN_FILE: githubTokenFile,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /sk-test-minimax-value/);
  assert.doesNotMatch(result.stdout, /ghp_test_github_value/);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, true);
  assert.equal(status.minimaxKeyFile.present, true);
  assert.equal(status.githubTokenFile.present, true);
});

test("setup-local-secrets --check fails closed when files are absent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-secret-missing-"));
  const result = spawnSync(process.execPath, ["scripts/setup-local-secrets.mjs", "--check"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY_FILE: join(tmp, "missing-minimax-key"),
      GITHUB_TOKEN_FILE: join(tmp, "missing-github-token"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, false);
  assert.equal(status.minimaxKeyFile.present, false);
  assert.equal(status.githubTokenFile.present, false);
});

test("setup-local-secrets --check uses default user config paths when path env vars are empty", () => {
  const result = spawnSync(process.execPath, ["scripts/setup-local-secrets.mjs", "--check"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY_FILE: "",
      GITHUB_TOKEN_FILE: "",
    },
    encoding: "utf8",
  });

  assert.ok(result.status === 0 || result.status === 2);
  const status = JSON.parse(result.stdout);
  assert.equal(status.minimaxKeyFile.path.endsWith(`${sep}.config${sep}alaya${sep}openai-api-key`), true);
  assert.equal(status.githubTokenFile.path.endsWith(`${sep}.config${sep}alaya${sep}github-token`), true);
});

test("setup-local-secrets --check fails closed when secret file permissions are too broad", () => {
  if (process.platform === "win32") return;
  const tmp = mkdtempSync(join(tmpdir(), "alaya-secret-mode-"));
  const minimaxKeyFile = join(tmp, "minimax-key");
  const githubTokenFile = join(tmp, "github-token");
  writeFileSync(minimaxKeyFile, "sk-test-minimax-value-that-must-not-be-printed\n");
  writeFileSync(githubTokenFile, "ghp_test_github_value_that_must_not_be_printed\n", { mode: 0o600 });
  chmodSync(minimaxKeyFile, 0o644);
  chmodSync(githubTokenFile, 0o600);

  const result = spawnSync(process.execPath, ["scripts/setup-local-secrets.mjs", "--check"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY_FILE: minimaxKeyFile,
      GITHUB_TOKEN_FILE: githubTokenFile,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /sk-test-minimax-value/);
  assert.doesNotMatch(result.stdout, /ghp_test_github_value/);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, false);
  assert.equal(status.minimaxKeyFile.present, true);
  assert.equal(status.minimaxKeyFile.nonEmpty, true);
  assert.equal(status.minimaxKeyFile.mode, "0644");
  assert.equal(status.minimaxKeyFile.modeSecure, false);
  assert.equal(status.minimaxKeyFile.usable, false);
  assert.equal(status.githubTokenFile.usable, true);
});

test("e2e-live-upgrade refuses broad-permission local secret files before any live run", () => {
  if (process.platform === "win32") return;
  const tmp = mkdtempSync(join(tmpdir(), "alaya-live-secret-mode-"));
  const minimaxKeyFile = join(tmp, "minimax-key");
  const githubTokenFile = join(tmp, "github-token");
  writeFileSync(minimaxKeyFile, "sk-test-minimax-value-that-must-not-be-printed\n");
  writeFileSync(githubTokenFile, "ghp_test_github_value_that_must_not_be_printed\n", { mode: 0o600 });
  chmodSync(minimaxKeyFile, 0o644);
  chmodSync(githubTokenFile, 0o600);

  const result = spawnSync(process.execPath, ["scripts/e2e-live-upgrade.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      GITHUB_TOKEN: "",
      ALAYA_GITHUB_TOKEN: "",
      OPENAI_API_KEY_FILE: minimaxKeyFile,
      GITHUB_TOKEN_FILE: githubTokenFile,
      ALAYA_E2E_GITHUB_OWNER: "owner",
      ALAYA_E2E_GITHUB_REPO: "repo",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /mode 0644; expected 0600/);
  assert.doesNotMatch(result.stderr, /sk-test-minimax-value/);
  assert.doesNotMatch(result.stderr, /ghp_test_github_value/);
});

test("24h validation runner distinguishes missing live prereqs from network-blocked live", () => {
  const source = readFileSync(join(root, "scripts", "24h_validation.sh"), "utf8");

  assert.match(source, /MINIMAX_API_KEY/);
  assert.match(source, /GH_PAT/);
  assert.match(source, /ALAYA_LLM_CONNECTIVITY_URL/);
  assert.match(source, /ALAYA_GITHUB_CONNECTIVITY_URL/);
  assert.match(source, /LIVE=SKIP_NET/);
  assert.match(source, /live SKIP_NET/);
  assert.match(source, /Live validation skipped because API connectivity is unavailable\./);
  assert.match(source, /if \[ "\$ERRORS" -gt 0 \]; then/);
  assert.match(source, /Validation failed with \$ERRORS failed step\(s\)\./);
});

test("12h validation runner keeps non-critical failures non-blocking", () => {
  const source = readFileSync(join(root, "scripts", "12h_validation.sh"), "utf8");

  assert.match(source, /ALAYA_VALIDATION_DURATION_SECONDS:-43200/);
  assert.match(source, /ALAYA_VALIDATION_SLEEP_SECONDS:-600/);
  assert.match(source, /ALAYA_VALIDATION_MAX_ROUNDS:-72/);
  assert.match(source, /tests\/principles\.guard\.test\.ts/);
  assert.match(source, /npm run flywheel/);
  assert.match(source, /npm run e2e:llm-flywheel/);
  assert.match(source, /ALERT: 3 consecutive non-critical validation errors/);
  assert.match(source, /continuing\./);
  assert.match(source, /FLYWHEEL_CONSEC=0/);
  assert.match(source, /LIVE_CONNECTIVITY_CONSEC=0/);
  assert.match(source, /LIVE_E2E_CONSEC=0/);
  assert.match(source, /HEALTH_CONSEC=0/);
  assert.match(source, /record_noncritical_failure "live connectivity" "\$ROUND"/);
  assert.match(source, /record_noncritical_failure "flywheel health" "\$ROUND"/);
  assert.match(source, /record_noncritical_success "flywheel health"/);
  assert.doesNotMatch(source, /Stopping after .*consecutive/);
  assert.doesNotMatch(source, /Validation failed with \$ERRORS failed step/);
});

test("live upgrade app startup disables blocking demo seed", () => {
  const liveSource = readFileSync(join(root, "scripts", "e2e-live-upgrade.mjs"), "utf8");
  const serverSource = readFileSync(join(root, "alaya-app", "server", "index.ts"), "utf8");

  assert.match(liveSource, /ALAYA_AUTO_SEED_DEMO: "false"/);
  assert.match(liveSource, /OPENAI_MAX_OUTPUT_TOKENS.*"1024"/);
  assert.match(liveSource, /ALAYA_REAL_LLM_MAX_RETRIES.*"2"/);
  assert.match(serverSource, /ALAYA_AUTO_SEED_DEMO !== "false"/);
  assert.ok(
    serverSource.indexOf("await seedDemo()") < serverSource.indexOf("startCycleScheduler()"),
    "server startup should finish demo seeding before enabling the scheduler",
  );
  assert.match(serverSource, /server is reachable/);
});

test("UI onboarding E2E uses the current New Project form labels", () => {
  const scriptSource = readFileSync(join(root, "scripts", "e2e-ui-onboarding-cycle.mjs"), "utf8");
  const pageSource = readFileSync(join(root, "alaya-app", "client", "src", "pages", "NewProject.tsx"), "utf8");
  const gatesSource = readFileSync(join(root, "alaya-app", "client", "src", "pages", "Gates.tsx"), "utf8");

  assert.match(pageSource, /label="目标阈值"/);
  assert.match(scriptSource, /fillByLabel\(page, "目标阈值"/);
  assert.doesNotMatch(scriptSource, /fillByLabel\(page, "第一轮目标阈值"/);
  assert.match(gatesSource, /data-testid="button-confirm-gate-action"/);
  assert.ok(
    gatesSource.indexOf("if (p.userQuote)") < gatesSource.indexOf("if (p.summary)"),
    "Human Gates should display redacted external feedback quotes before generic summaries",
  );
  assert.match(scriptSource, /button-confirm-gate-action/);
  assert.match(scriptSource, /已闭环/);
  assert.doesNotMatch(scriptSource, /selectedCycleText\.includes\("closed"\)/);
});

test("validation-summary reports total rounds, failures and first positive delta", () => {
  const tmp = mkdtempSync(join(tmpdir(), "alaya-validation-summary-"));
  const summary = join(tmp, "SUMMARY.csv");
  writeFileSync(summary, [
    "round,timestamp,guard,sim,live,delta",
    "1,10:00:00,PASS,PASS,SKIP,NA",
    "2,10:10:00,PASS,PASS,SKIP,0",
    "3,10:20:00,PASS,PASS,SKIP_NET,2",
    "4,10:30:00,PASS,FAIL,SKIP,2",
    "",
  ].join("\n"));

  const result = spawnSync(process.execPath, ["scripts/validation-summary.mjs", summary], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.totalRounds, 4);
  assert.equal(parsed.errors, 1);
  assert.equal(parsed.firstDeltaPositiveRound, 3);
  assert.equal(parsed.lastRound, 4);
  assert.equal(parsed.lastDelta, "2");
  assert.equal(parsed.statusCounts.live.SKIP_NET, 1);
});
