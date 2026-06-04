#!/usr/bin/env node
/**
 * Alaya 宪法守卫 (Constitution Guard)
 * 静态检查 PRINCIPLES.md 中可机检的底线。任何一条违反则 exit 1，阻断 CI / 提交。
 *
 * 用法：
 *   node scripts/check-principles.mjs            # 自动探测 alaya-app / alaya-core
 *   node scripts/check-principles.mjs <root> ... # 显式指定一个或多个项目根目录
 *
 * 退出码：0 = 全部通过；1 = 至少一条底线被违反；2 = 脚本自身错误（如找不到纯函数文件）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// ---------- 配置 ----------
// 纯函数文件名（不含目录），底线 1 检查对象
const PURE_FN_FILES = [
  "compute_error.ts",
  "classify_error.ts",
  "update_confidence.ts",
  "transition_state.ts",
];
// 纯函数可能所在的目录（相对项目根）
const PURE_FN_DIRS = ["shared/core", "src/core"];

// 底线 1：纯函数里禁止出现的 import / 调用（副作用来源）
const FORBIDDEN_IN_PURE = [
  { re: /\bfrom\s+["'](?:better-sqlite3|drizzle-orm|drizzle-orm\/.*)["']/, why: "数据库依赖" },
  { re: /\bfrom\s+["'](?:openai|anthropic|@anthropic-ai\/.*|@google\/.*)["']/, why: "LLM SDK 依赖" },
  { re: /\bfrom\s+["']node:(?:fs|fs\/promises)["']/, why: "文件系统依赖" },
  { re: /\brequire\(\s*["'](?:fs|better-sqlite3|drizzle-orm|openai|anthropic)["']\s*\)/, why: "副作用模块 require" },
  { re: /\b(?:console\.(?:log|info|warn|error)|process\.env)\b/, why: "副作用/全局状态（日志或环境变量）" },
  { re: /\bDate\.now\s*\(\)|\bnew\s+Date\s*\(\s*\)/, why: "隐式当前时间（时间必须作为入参传入）" },
];

// 底线 6：业务代码（server/）禁止直接 import LLM SDK，必须走 LLMProvider 接口
const LLM_SDK_IMPORT = /\bfrom\s+["'](?:openai|anthropic|@anthropic-ai\/.*)["']|\brequire\(\s*["'](?:openai|anthropic)["']/;

// 底线 3：写权限审计不可旁路。server/ 中只有统一数据访问层可裸写数据库。
const RAW_DB_WRITE = /\brawDb\s*\.\s*prepare\s*\([\s\S]*?\)\s*\.\s*run\s*\(/g;
const DRIZZLE_WRITE = /(?:^|[^\w.])db\s*\.\s*(?:insert|update|delete)\s*\(/g;
const AUDIT_CALL = /\bthis\.(?:auditWrite|recordAudit)\s*\(/;

// ---------- 工具 ----------
const errors = [];
const passed = [];
function fail(rule, detail) { errors.push(`  ✗ [${rule}] ${detail}`); }
function pass(rule, detail) { passed.push(`  ✓ [${rule}] ${detail}`); }

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
}

// 去掉块注释与行注释，避免在注释里出现关键字造成误报
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function hasDbWrite(code) {
  RAW_DB_WRITE.lastIndex = 0;
  DRIZZLE_WRITE.lastIndex = 0;
  return RAW_DB_WRITE.test(code) || DRIZZLE_WRITE.test(code);
}

function lineForIndex(code, idx) {
  return code.slice(0, idx).split("\n").length;
}

function findMatchingBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractClassMethods(code, className) {
  const classIdx = code.indexOf(`class ${className}`);
  if (classIdx === -1) return [];
  const classOpen = code.indexOf("{", classIdx);
  const classClose = findMatchingBrace(code, classOpen);
  if (classOpen === -1 || classClose === -1) return [];

  const body = code.slice(classOpen + 1, classClose);
  const methods = [];
  const methodRe = /^\s+(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::[^{]+)?\{/gm;
  let m;
  while ((m = methodRe.exec(body))) {
    const localOpen = methodRe.lastIndex - 1;
    const localClose = findMatchingBrace(body, localOpen);
    if (localClose === -1) continue;
    const start = classOpen + 1 + m.index;
    methods.push({
      name: m[1],
      body: body.slice(localOpen, localClose + 1),
      line: lineForIndex(code, start),
    });
    methodRe.lastIndex = localClose + 1;
  }
  return methods;
}

// ---------- 检查项 ----------
function checkPureFunctions(root) {
  let foundAny = false;
  for (const dir of PURE_FN_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const fname of PURE_FN_FILES) {
      const fp = join(base, fname);
      if (!existsSync(fp)) continue;
      foundAny = true;
      const code = stripComments(readFileSync(fp, "utf8"));
      const rel = relative(root, fp);
      let clean = true;
      for (const { re, why } of FORBIDDEN_IN_PURE) {
        if (re.test(code)) { fail("底线1-纯函数", `${rel} 含${why}`); clean = false; }
      }
      if (clean) pass("底线1-纯函数", `${rel} 保持纯`);
    }
  }
  return foundAny;
}

function checkStrongRequiresHuman(root) {
  // 底线 2：transition_state 中 active->strong 必须 requiresHuman:true
  for (const dir of PURE_FN_DIRS) {
    const fp = join(root, dir, "transition_state.ts");
    if (!existsSync(fp)) continue;
    const code = readFileSync(fp, "utf8");
    const rel = relative(root, fp);
    // 找到含 nextStatus: "strong" 的迁移返回语句，附近必须出现 requiresHuman: true
    const strongReturns = [...code.matchAll(/nextStatus:\s*["']strong["'][^}]*}/g)];
    if (strongReturns.length === 0) {
      fail("底线2-人类闸", `${rel} 未找到晋级 strong 的返回语句（结构可能被改动）`);
      continue;
    }
    let ok = true;
    for (const m of strongReturns) {
      if (!/requiresHuman:\s*true/.test(m[0])) {
        fail("底线2-人类闸", `${rel} 存在未要求人类批准的 strong 晋级：${m[0].slice(0, 80)}…`);
        ok = false;
      }
    }
    // 反向哨兵：禁止出现 auto-approve 类后门
    if (/auto[_-]?approve|skipHumanGate|bypassGate|forceStrong/i.test(code)) {
      fail("底线2-人类闸", `${rel} 出现疑似绕过人类闸的后门标识符`);
      ok = false;
    }
    if (ok) pass("底线2-人类闸", `${rel} 所有 strong 晋级均要求人类批准`);
  }
}

function checkAuditBypass(root) {
  // 底线 3：禁止 server/ 业务代码绕过 storage.ts 裸写数据库；storage 写路径必须带审计辅助。
  const serverDir = join(root, "server");
  if (!existsSync(serverDir)) return;

  const files = walk(serverDir, [".ts"]);
  let ok = true;

  for (const fp of files) {
    const rel = relative(root, fp);
    if (rel === "server/storage.ts" || /server\/.*audit.*\.ts$/i.test(rel)) continue;

    const code = stripComments(readFileSync(fp, "utf8"));
    if (hasDbWrite(code)) {
      fail("底线3-审计旁路", `${rel} 存在裸写数据库调用，应经由 server/storage.ts 的审计路径`);
      ok = false;
    }
  }

  const storageFile = join(root, "server", "storage.ts");
  if (!existsSync(storageFile)) {
    fail("底线3-审计旁路", `${relative(root, serverDir)} 缺少统一数据访问层 storage.ts`);
    return;
  }

  const storageCode = stripComments(readFileSync(storageFile, "utf8"));
  const relStorage = relative(root, storageFile);
  if (!/INSERT\s+INTO\s+event_log\s*\([^)]*\bactor\b/i.test(storageCode)) {
    fail("底线3-审计旁路", `${relStorage} 的 event_log 写入缺少 actor 字段`);
    ok = false;
  }
  if (!/\bauditWrite\s*\(/.test(storageCode)) {
    fail("底线3-审计旁路", `${relStorage} 缺少统一审计辅助函数 auditWrite`);
    ok = false;
  }

  const methods = extractClassMethods(storageCode, "DatabaseStorage");
  if (methods.length === 0) {
    fail("底线3-审计旁路", `${relStorage} 未能识别 DatabaseStorage 方法，审计检查无法进行`);
    ok = false;
  }

  for (const method of methods) {
    if (method.name === "recordEvent" || method.name === "auditWrite") continue;
    if (hasDbWrite(method.body) && !AUDIT_CALL.test(method.body)) {
      fail("底线3-审计旁路", `${relStorage}:${method.line} ${method.name}() 有数据库写操作但未调用 this.auditWrite(...)`);
      ok = false;
    }
  }

  if (ok) pass("底线3-审计旁路", `${relative(resolve(root, ".."), root) || root} 写操作均经过 storage.ts 审计路径`);
}

function checkPollutedNotInEvidence(root) {
  // 底线 4：硬约束注释/逻辑必须存在 —— 至少保证 quarantined/conflict 被识别为状态
  for (const dir of PURE_FN_DIRS) {
    const fp = join(root, dir, "transition_state.ts");
    if (!existsSync(fp)) continue;
    const code = readFileSync(fp, "utf8");
    const rel = relative(root, fp);
    const required = ["quarantined", "conflict", "stale"];
    const missing = required.filter((s) => !code.includes(s));
    if (missing.length) fail("底线4-脏知识隔离", `${rel} 缺少受污染状态定义: ${missing.join(", ")}`);
    else pass("底线4-脏知识隔离", `${rel} 受污染状态 (stale/quarantined/conflict) 齐备`);
  }
}

function checkGrayZone(root) {
  // 底线 5：update_confidence 必须保留灰区弱累加逻辑
  for (const dir of PURE_FN_DIRS) {
    const fp = join(root, dir, "update_confidence.ts");
    if (!existsSync(fp)) continue;
    const code = readFileSync(fp, "utf8");
    const rel = relative(root, fp);
    const hasGrayConst = /GRAY_LOW|0\.3/.test(code) && /GRAY_HIGH|0\.7/.test(code);
    const hasWeakAccum = /\+=\s*0\.5/.test(code);
    if (hasGrayConst && hasWeakAccum) pass("底线5-灰区", `${rel} 灰区弱累加机制完好`);
    else fail("底线5-灰区", `${rel} 灰区机制疑似被简化（缺少 0.3/0.7 边界或 0.5 弱累加）`);
  }
}

function checkNoDirectLlmImport(root) {
  // 底线 6：server/ 下业务代码不得直接 import LLM SDK（应走 LLMProvider）
  const serverDir = join(root, "server");
  const srcDir = join(root, "src");
  const files = [...walk(serverDir, [".ts"]), ...walk(srcDir, [".ts"])];
  // 允许 provider 实现文件本身 import（文件名含 provider / llm 的视为接口实现层）
  let bad = false;
  for (const fp of files) {
    const rel = relative(root, fp);
    if (/provider|llm/i.test(rel)) continue; // 接口实现层豁免
    const code = stripComments(readFileSync(fp, "utf8"));
    if (LLM_SDK_IMPORT.test(code)) { fail("底线6-LLM接口", `${rel} 业务代码直接 import LLM SDK，应通过 LLMProvider`); bad = true; }
  }
  if (!bad) pass("底线6-LLM接口", `${relative(resolve(root, ".."), root) || root} 业务代码无直接 LLM SDK 依赖`);
}

function checkProject(root) {
  console.log(`\n── 检查项目: ${root} ──`);
  const found = checkPureFunctions(root);
  if (!found) {
    console.error(`  ! 未在 ${PURE_FN_DIRS.join(" / ")} 找到任何纯函数文件，跳过该根目录`);
    return;
  }
  checkStrongRequiresHuman(root);
  checkAuditBypass(root);
  checkPollutedNotInEvidence(root);
  checkGrayZone(root);
  checkNoDirectLlmImport(root);
}

// ---------- 主流程 ----------
function detectRoots() {
  const explicit = process.argv.slice(2);
  if (explicit.length) return explicit.map((p) => resolve(p));
  // 自动探测：当前目录、./alaya-app、./alaya-core、../alaya-app、../alaya-core
  const cands = [".", "alaya-app", "alaya-core", "../alaya-app", "../alaya-core"];
  const roots = [];
  for (const c of cands) {
    const r = resolve(c);
    if (PURE_FN_DIRS.some((d) => existsSync(join(r, d)))) roots.push(r);
  }
  return [...new Set(roots)];
}

const roots = detectRoots();
if (roots.length === 0) {
  console.error("未找到含 shared/core 或 src/core 的项目根目录。请显式传入路径。");
  process.exit(2);
}
for (const r of roots) checkProject(r);

console.log("\n" + "═".repeat(50));
if (passed.length) console.log("通过:\n" + passed.join("\n"));
if (errors.length) {
  console.error("\n违反底线:\n" + errors.join("\n"));
  console.error(`\n✗ 宪法守卫失败：${errors.length} 条底线被违反。修复后再提交。`);
  process.exit(1);
}
console.log(`\n✓ 宪法守卫通过：${passed.length} 项检查全部满足。`);
process.exit(0);
