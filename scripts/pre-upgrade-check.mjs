#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);

function git(command) {
  try {
    return execSync(command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const dbPath = resolve(root, process.env.ALAYA_DB_PATH || "alaya-app/data.db");
const checks = [
  { name: "git_commit", ok: !!git("git rev-parse HEAD"), detail: git("git rev-parse HEAD") },
  { name: "git_branch", ok: !!git("git rev-parse --abbrev-ref HEAD"), detail: git("git rev-parse --abbrev-ref HEAD") },
  { name: "working_tree_visible", ok: true, detail: git("git status --short") || "clean" },
  { name: "database_path_known", ok: true, detail: dbPath },
  { name: "database_exists_or_new_install", ok: !existsSync(dbPath) || statSync(dbPath).isFile(), detail: existsSync(dbPath) ? "exists" : "new install" },
  { name: "backup_command", ok: true, detail: "Run npm run ops:backup before ALAYA_CAP_DATABASE_MIGRATION=true npm run ops:migrate" },
  { name: "env_not_tracked", ok: !git("git ls-files .env .env.local alaya-app/.env").trim(), detail: "tracked .env files are forbidden" },
];

const failed = checks.filter((check) => !check.ok);
const report = { status: failed.length ? "blocked" : "ok", checks };
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exit(1);
