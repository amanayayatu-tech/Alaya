#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const backupArg = args.find((arg) => arg.startsWith("--backup="))?.slice("--backup=".length) || args[args.indexOf("--backup") + 1];
const confirm = args.includes("--confirm");

if (!backupArg) {
  console.error("Usage: node scripts/restore-state.mjs --backup <backup-dir> [--confirm]");
  process.exit(2);
}

const backupDir = resolve(backupArg);
const manifestPath = join(backupDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Missing manifest: ${manifestPath}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const targetDb = resolve(root, process.env.ALAYA_DB_PATH || manifest.sourceDbPath || "alaya-app/data.db");
const filesDir = join(backupDir, "files");
const files = existsSync(filesDir) ? readdirSync(filesDir) : [];
const plan = files.map((name) => ({
  from: join(filesDir, name),
  to: name.startsWith(basename(targetDb)) ? join(targetDb + name.slice(basename(targetDb).length)) : join(resolve(root, "tmp", "restored-extra"), name),
}));

if (!confirm) {
  console.log(JSON.stringify({
    status: "dry_run",
    message: "No files restored. Re-run with --confirm after stopping Alaya.",
    backupDir,
    plan,
  }, null, 2));
  process.exit(0);
}

for (const item of plan) {
  mkdirSync(dirname(item.to), { recursive: true });
  copyFileSync(item.from, item.to);
}

console.log(JSON.stringify({ status: "restored", backupDir, restored: plan }, null, 2));
