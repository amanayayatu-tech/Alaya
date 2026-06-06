#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", ".vite", "coverage", "tmp", "temp", "validation-logs", "backups"]);
const EXCLUDED_FILES = [/package-lock\.json$/, /\.db(?:-shm|-wal|-journal)?$/, /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.pdf$/];

const patterns = [
  { name: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "openai_style_key", re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{24,}\b/ },
  { name: "minimax_style_key", re: /\b(?:minimax|mm)[-_][A-Za-z0-9_-]{24,}\b/i },
  { name: "bearer_token", re: /\bBearer\s+(?!\$|\[|<|your|redacted|test|dummy)[A-Za-z0-9._~+/=-]{24,}\b/i },
  { name: "database_url_password", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@/i },
  { name: "cookie_secret", re: /\b(?:Cookie|Set-Cookie):\s*[^;\n=]+=[A-Za-z0-9._~+/=-]{20,}/i },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/ },
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("node_modules")) continue;
    const path = join(dir, name);
    const rel = relative(root, path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(name)) walk(path, acc);
    } else if (!EXCLUDED_FILES.some((re) => re.test(rel))) {
      acc.push(path);
    }
  }
  return acc;
}

function likelyPlaceholder(line, rel) {
  const lower = line.toLowerCase();
  if (rel.endsWith("secret.redaction.test.ts") && /BEGIN [A-Z ]*PRIVATE KEY/.test(line)) return true;
  return [
    "sk-test",
    "ghp_test",
    "fake",
    "dummy",
    "example",
    "placeholder",
    "redacted",
    "not-a-real",
    "must-not-be-printed",
    "must_not_leak",
    "abcdefghijklmnopqrstuvwxyz",
    "notarealsecret",
  ].some((marker) => lower.includes(marker));
}

const findings = [];
if (existsSync(root)) {
  for (const file of walk(root)) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (likelyPlaceholder(line, rel)) return;
      for (const pattern of patterns) {
        if (pattern.re.test(line)) {
          findings.push({ file: rel, line: index + 1, type: pattern.name });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error("Potential high-confidence secrets found:");
  for (const finding of findings) console.error(`- ${finding.file}:${finding.line} ${finding.type}`);
  process.exit(1);
}

console.log("Secret scan passed: no high-confidence secrets found.");
