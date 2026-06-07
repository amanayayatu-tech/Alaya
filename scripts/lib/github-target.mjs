import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function parseGitHubRemoteUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const remote = value.trim();
  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

function originRemoteFromGitConfig(cwd) {
  const configPath = join(cwd, ".git", "config");
  if (!existsSync(configPath)) return "";
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)]\s*$/);
    if (section) {
      inOrigin = section[1] === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url) return url[1];
  }
  return "";
}

export function inferGitHubTarget({ cwd = process.cwd(), env = process.env } = {}) {
  const sandboxOwner = env.ALAYA_E2E_GITHUB_SANDBOX_OWNER;
  const sandboxRepo = env.ALAYA_E2E_GITHUB_SANDBOX_REPO;
  if (sandboxOwner && sandboxRepo) {
    return { owner: sandboxOwner, repo: sandboxRepo, source: "sandbox env" };
  }

  const envOwner = env.ALAYA_E2E_GITHUB_OWNER;
  const envRepo = env.ALAYA_E2E_GITHUB_REPO;
  if (envOwner && envRepo) {
    return { owner: envOwner, repo: envRepo, source: "env" };
  }

  const explicitRemote = env.ALAYA_E2E_GITHUB_REMOTE_URL;
  const explicit = parseGitHubRemoteUrl(explicitRemote);
  if (explicit) return { ...explicit, source: "ALAYA_E2E_GITHUB_REMOTE_URL" };

  const origin = parseGitHubRemoteUrl(originRemoteFromGitConfig(cwd));
  if (origin) return { ...origin, source: "git remote origin" };

  return { owner: "", repo: "", source: "missing" };
}
