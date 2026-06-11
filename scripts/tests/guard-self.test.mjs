// 宪法守卫自身的元测试（meta-test）
//
// 目的：把 check-principles.mjs 历史上的三个 bug 固定成回归测试。
//   bug 1: 用于 .test() 的正则带 g 标志，lastIndex 跨调用污染。
//   bug 2: findMatchingBrace 不跳过字符串/模板/注释里的 { }，方法体边界错位。
//   bug 3: 自动探测向上跨越仓库根，误扫父目录同名旧副本。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const guard = join(repoRoot, "scripts", "check-principles.mjs");

function runGuard(args = [], cwd = repoRoot) {
  return spawnSync(process.execPath, [guard, ...args], { cwd, encoding: "utf8" });
}

test("守卫对当前合规仓库连跑 5 次结果稳定为 0", () => {
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push(runGuard().status);
  assert.deepEqual(codes, [0, 0, 0, 0, 0], `退出码应恒为 0，实际：${codes}`);
});

test("守卫显式传两个 root 连跑 5 次也稳定为 0", () => {
  const args = [join(repoRoot, "alaya-app"), join(repoRoot, "alaya-core")];
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push(runGuard(args).status);
  assert.deepEqual(codes, [0, 0, 0, 0, 0], `退出码应恒为 0，实际：${codes}`);
});

test("自动探测只检查仓库内的 alaya-app / alaya-core，从任意 cwd 调用结果一致", () => {
  const fromRepo = runGuard([], repoRoot);
  const fromTmp = runGuard([], tmpdir());
  assert.equal(fromRepo.status, 0);
  assert.equal(fromTmp.status, 0, "从仓库外 cwd 调用也应通过");

  const out = fromRepo.stdout + fromRepo.stderr;
  const projectLines = out.split("\n").filter((line) => line.includes("检查项目"));
  assert.ok(projectLines.length >= 2, "应至少探测到 alaya-app 与 alaya-core");
  for (const line of projectLines) {
    assert.ok(line.includes(repoRoot), `探测到的 root 必须在仓库内：${line}`);
  }
});

test("纯函数注入 better-sqlite3 import 触发底线1失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "alaya-guard-"));
  try {
    cpSync(repoRoot, dir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes(join(repoRoot, ".git")),
    });
    const target = join(dir, "alaya-core", "src", "core", "compute_error.ts");
    const orig = readFileSync(target, "utf8");
    writeFileSync(target, `import Database from "better-sqlite3";\n${orig}`);
    const res = runGuard([join(dir, "alaya-core")], dir);
    assert.equal(res.status, 1, "注入 db import 后应失败");
    assert.match(res.stdout + res.stderr, /底线1-纯函数.*数据库依赖/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage.ts 删除一处 auditWrite 触发底线3失败并精确定位方法", () => {
  const dir = mkdtempSync(join(tmpdir(), "alaya-guard-"));
  try {
    cpSync(repoRoot, dir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes(join(repoRoot, ".git")),
    });
    const target = join(dir, "alaya-app", "server", "storage.ts");
    const src = readFileSync(target, "utf8");
    const lines = src.split("\n");
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
      if (/this\.auditWrite\([^\n]*knowledge_items[^\n]*insert/.test(lines[i])) {
        lines.splice(i, 1);
        removed = true;
        break;
      }
    }
    assert.ok(removed, "夹具准备失败：未找到 createKnowledge 的审计调用");
    writeFileSync(target, lines.join("\n"));
    const res = runGuard([join(dir, "alaya-app")], dir);
    assert.equal(res.status, 1, "删除审计调用后应失败");
    assert.match(res.stdout + res.stderr, /底线3-审计旁路.*createKnowledge\(\)/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HumanGateService 外直接 updateGate 触发 gate 状态入口失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "alaya-guard-"));
  try {
    cpSync(repoRoot, dir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes(join(repoRoot, ".git")),
    });
    const target = join(dir, "alaya-app", "server", "rogueGate.ts");
    writeFileSync(
      target,
      [
        'import { storage } from "./storage";',
        'export function bypassGate(gateId){',
        `  return storage.${"update" + "Gate"}(gateId, { status: "approved", decision: "approve" });`,
        "}",
      ].join("\n"),
    );
    const res = runGuard([join(dir, "alaya-app")], dir);
    assert.equal(res.status, 1, "HumanGateService 外 updateGate 后应失败");
    assert.match(res.stdout + res.stderr, /底线3-gate状态入口.*rogueGate\.ts/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("方法体内 .run({...}) 对象字面量花括号不影响审计检测", () => {
  const dir = mkdtempSync(join(tmpdir(), "alaya-guard-min-"));
  try {
    const app = join(dir, "alaya-app");
    mkdirSync(join(app, "server"), { recursive: true });
    const storage = [
      "const rawDb = {} as any;",
      "export class DatabaseStorage {",
      "  private auditWrite(actor: string, t: string, op: string, b: unknown, a: unknown){",
      "    rawDb.prepare(`INSERT INTO event_log (actor) VALUES (?)`).run(actor);",
      "  }",
      "  createKnowledge(k: any){",
      "    rawDb.prepare(`INSERT INTO knowledge_items (id,claim) VALUES (@id,@claim)`).run({ id: k.id, claim: k.claim });",
      '    this.auditWrite("distiller", "knowledge_items", "insert", null, k);',
      "    return k;",
      "  }",
      "}",
    ].join("\n");
    writeFileSync(join(app, "server", "storage.ts"), storage);
    const res = runGuard([app], dir);
    assert.equal(res.status, 0, `合规最小用例应通过，输出：\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /底线3-审计旁路.*审计路径/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
