#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const minimaxKeyFile = process.env.OPENAI_API_KEY_FILE?.trim() || "/private/tmp/alaya-minimax-key";
const githubTokenFile = process.env.GITHUB_TOKEN_FILE?.trim() || "/private/tmp/alaya-github-token";
const checkOnly = process.argv.includes("--check");
const overwrite = process.argv.includes("--overwrite");

function readSecretFile(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function present(path) {
  return existsSync(path) && readSecretFile(path).length > 0;
}

function modeStatus(path) {
  if (!existsSync(path)) return { mode: null, secure: false };
  if (process.platform === "win32") return { mode: null, secure: true };
  const mode = statSync(path).mode & 0o777;
  return {
    mode: `0${mode.toString(8)}`,
    secure: (mode & 0o077) === 0,
  };
}

function fileStatus(path) {
  const mode = modeStatus(path);
  const nonEmpty = present(path);
  return {
    path,
    present: existsSync(path),
    nonEmpty,
    mode: mode.mode,
    modeSecure: mode.secure,
    usable: nonEmpty && mode.secure,
  };
}

function printStatus() {
  const minimax = fileStatus(minimaxKeyFile);
  const github = fileStatus(githubTokenFile);
  const status = {
    ok: minimax.usable && github.usable,
    minimaxKeyFile: minimax,
    githubTokenFile: github,
  };
  console.log(JSON.stringify(status, null, 2));
  return status.ok;
}

function assertTty() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("setup:secrets needs an interactive TTY so secrets are not echoed or written into shell history.");
    console.error(`Missing files can be created manually with chmod 600: ${minimaxKeyFile}, ${githubTokenFile}`);
    process.exit(2);
  }
}

function readHidden(prompt) {
  assertTty();
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    let value = "";

    stdout.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdout.write("\n");
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (code >= 32) value += char;
      }
    };

    stdin.on("data", onData);
  });
}

function writeSecret(path, value) {
  if (!value) return false;
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

async function ensureSecret({ label, path, prompt, validate }) {
  if (present(path) && !overwrite) {
    console.log(`${label}: already present at ${path}`);
    return;
  }
  const value = await readHidden(prompt);
  if (!validate(value)) {
    console.error(`${label}: value did not pass a minimal local validation; file was not written.`);
    process.exit(2);
  }
  writeSecret(path, value);
  console.log(`${label}: wrote ${path} with mode 0600`);
}

async function main() {
  if (checkOnly) {
    process.exit(printStatus() ? 0 : 2);
  }

  await ensureSecret({
    label: "MiniMax/OpenAI-compatible key",
    path: minimaxKeyFile,
    prompt: `Paste MiniMax/OpenAI-compatible API key for ${minimaxKeyFile}: `,
    validate: (value) => /^sk-[A-Za-z0-9_-]{20,}$/.test(value),
  });
  await ensureSecret({
    label: "GitHub token",
    path: githubTokenFile,
    prompt: `Paste GitHub token for ${githubTokenFile}: `,
    validate: (value) => /^[A-Za-z0-9_ghopsu-]{20,}$/.test(value),
  });

  printStatus();
}

main().catch((error) => {
  console.error(`setup:secrets failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
