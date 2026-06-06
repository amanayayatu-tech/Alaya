#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = new Map(process.argv.slice(2).map((arg, index, arr) => {
  if (!arg.startsWith("--")) return [arg, ""];
  const [key, inline] = arg.split("=", 2);
  return [key, inline ?? arr[index + 1] ?? ""];
}));

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function git(command) {
  try {
    return execSync(command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function copyIfExists(path, destDir) {
  if (!path || !existsSync(path) || statSync(path).isDirectory()) return null;
  const target = join(destDir, basename(path));
  copyFileSync(path, target);
  return target;
}

const outRoot = resolve(args.get("--out") || join(root, "tmp", "alaya-backups", `backup-${timestamp()}`));
const filesDir = join(outRoot, "files");
mkdirSync(filesDir, { recursive: true });

const dbPath = resolve(root, process.env.ALAYA_DB_PATH || "alaya-app/data.db");
const copied = [
  copyIfExists(dbPath, filesDir),
  copyIfExists(`${dbPath}-wal`, filesDir),
  copyIfExists(`${dbPath}-shm`, filesDir),
  copyIfExists(`${dbPath}-journal`, filesDir),
].filter(Boolean);

for (const dir of ["validation-logs"]) {
  const source = join(root, dir);
  if (!existsSync(source)) continue;
  const names = readdirSync(source).slice(-5);
  const target = join(outRoot, dir);
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    const path = join(source, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(target, name));
  }
}

const manifest = {
  createdAt: new Date().toISOString(),
  root,
  gitBranch: git("git rev-parse --abbrev-ref HEAD"),
  gitCommit: git("git rev-parse HEAD"),
  sourceDbPath: dbPath,
  copiedFiles: copied.map((path) => path.replace(outRoot, ".")),
  envNamesPresent: Object.keys(process.env)
    .filter((key) => /^(ALAYA_|OPENAI_|GITHUB_|GH_|LLM_|MINIMAX_)/.test(key))
    .sort(),
  note: "Secret values and .env files are intentionally excluded.",
};
writeFileSync(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify({ status: "ok", backupDir: outRoot, copiedFiles: manifest.copiedFiles }, null, 2));
