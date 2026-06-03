# Alaya — 复利飞轮系统

> 一个让「认知复利」真正转起来的系统：每一轮飞轮的失败都被提炼成知识，知识改变下一轮的决策，决策被人类闸门约束在安全边界内。

本仓库包含两个互补的工程，共同实现了 Alaya PRD 的 Phase 1：

| 目录 | 里程碑 | 形态 | 一句话 |
| --- | --- | --- | --- |
| [`alaya-core/`](#1-alaya-core--m1m3-内核) | M1 + M3 | TypeScript/Node 命令行内核 | 验证「飞轮到底转不转」——四个纯函数 + 5 Agent + 3 轮飞轮模拟，34 单测全过 |
| [`alaya-app/`](#2-alaya-app--m2m4-全栈-mvp) | M2 + M4 | Express + React 全栈 Web 应用 | 完整 Phase 1 本地 MVP——SQLite + FTS5 持久化 + 5 个前端页面 |

两者共享同一套核心算法（四个纯函数 + 5 Agent 逻辑）。`alaya-core` 是先行验证的「裸内核」，`alaya-app` 是把同一套逻辑接上数据库与界面后的产品形态。

---

## 快速开始

### 从仓库根目录运行

```bash
npm run install:all
npm test          # alaya-core: 34 个单元测试
npm run flywheel  # alaya-core: 3 轮确定性飞轮模拟
npm run typecheck # core + app 类型检查
npm run build     # alaya-app 生产构建
```

### 看飞轮转不转（最快，30 秒）

```bash
cd alaya-core
npm install
npm test        # 34 个单元测试全过
npm run flywheel # 跑 3 轮确定性飞轮模拟，打印每轮决策、误差、知识晋级
```

### 跑完整 Web 应用

```bash
cd alaya-app
npm install
npm run dev     # 启动后端 + 前端，访问 http://localhost:5000
```

首次启动会自动创建 SQLite 数据库并 seed 一个「一键发布演示项目」（含 3 轮已跑完的飞轮、4 条知识、4 个闸门）。打开浏览器即可看到 Dashboard、Human Gates、Prediction Ledger、Knowledge Base、Cycle Review 五个页面。

> 要求：Node.js 20+。两个子项目也可以相互独立运行，各自 `npm install`。

### 运行参数

`alaya-app` 默认读取：

```bash
PORT=5000
HOST=0.0.0.0
REUSE_PORT=false
```

如果本机 `5000` 被占用，可以临时指定端口：

```bash
PORT=5001 npm --prefix alaya-app run dev
```

### 当前后端接入

当前运行链路是：

```text
React/Vite 前端 -> Express REST API -> SQLite + FTS5 -> mock flywheel/Agent/LLM
```

也就是说：项目现在没有调用外部 OpenAI/Anthropic API；`/api/llm-calls` 记录的是 deterministic mock LLM 调用日志。真实 LLM 预留在 `LLMProvider` 接口里。

---

## 1. `alaya-core` — M1/M3 内核

先行验证「认知复利」机制是否成立的最小内核。无数据库、无界面，纯逻辑 + 模拟。

```
alaya-core/
├── src/
│   ├── core/                  # 四个纯函数（系统的数学心脏）
│   │   ├── compute_error.ts       # 计算预测误差 E_cycle（支持「越小越好」指标、关键 claim 加权）
│   │   ├── classify_error.ts      # 误差归因：model / data / execution / external
│   │   ├── update_confidence.ts   # 贝叶斯式置信度更新 + 时间衰减
│   │   ├── transition_state.ts    # 知识状态机：draft → active → strong → verified
│   │   └── types.ts
│   ├── agents/agents.ts       # 5 Agent：Orchestrator / Sensor / Builder / Distiller / Librarian
│   ├── state/store.ts         # 内存状态存储
│   ├── llm/provider.ts        # LLMProvider 接口（默认 mock，可零改动切真实 LLM）
│   └── sim/
│       ├── scenario.ts            # 确定性场景：一键发布产品冷启动
│       └── run_flywheel.ts        # 跑 3 轮飞轮的入口
└── tests/                     # 34 个单元测试

命令：
  npm test         # 运行全部单测
  npm run flywheel # 运行 3 轮飞轮模拟
  npm run typecheck
```

**3 轮飞轮叙事（确定性，可复现）：**
1. 第 1 轮：假设「用户要快速发布」→ activation 0.12 失败，归因 model → 提炼知识 K1（用户对不可预期的自动操作有恐惧）
2. 第 2 轮：基于 K1 改做「预览」→ activation 0.34 达标 → 强化 K1，提炼 K2（可预览/可逆降低高风险动作使用门槛）
3. 第 3 轮：引用 K1+K2，避开「新增不可预览的自动化」（已被否决的方向），改做「删除操作加 dry-run 预览」→ K2 晋级 strong

第 3 轮的决策被前两轮的知识真实改变——这就是「复利成立」的判据（PRD 17.3 验收标准）。

---

## 2. `alaya-app` — M2/M4 全栈 MVP

把内核接上持久化与界面后的完整 Phase 1 产品。

```
alaya-app/
├── shared/
│   ├── schema.ts              # Drizzle 表定义：14 张表（11 核心 + version + event_log + FTS5 虚拟表）
│   └── core/                  # 复用自 alaya-core 的四个纯函数 + agents/scenario 参考实现
├── server/
│   ├── index.ts               # Express 入口
│   ├── storage.ts             # 数据访问层（含 FTS5 全文检索）
│   ├── flywheel.ts            # 5 Agent 的 SQLite 版本
│   ├── routes.ts              # REST API
│   ├── seed.ts                # 启动时 seed 演示项目（3 轮飞轮）
│   └── onboarding.ts          # onboarding interview → 写入 seed identity / world_model
├── client/src/
│   └── pages/                 # 5 个前端页面
│       ├── Dashboard.tsx          # 总览：飞轮阶段、闸门预算、最近知识、风险
│       ├── Gates.tsx              # Human Gates：方向闸 / 意义闸的批准·修改·拒绝
│       ├── Ledger.tsx             # Prediction Ledger：预测台账与误差
│       ├── Knowledge.tsx          # Knowledge Base：知识列表 + FTS5 搜索 + 晋级/隔离
│       └── Review.tsx             # Cycle Review：每轮复盘与 5 Agent 运行记录
├── BUILD_SPEC.md              # 构建规格
└── BUILD_REPORT.md            # 构建报告

命令：
  npm run dev    # 开发模式（后端 + 前端热更新），http://localhost:5000
  npm run build  # 构建生产产物到 dist/
  npm run start  # 运行生产构建（需先 build）
  npm run check  # 类型检查
```

**M2 — SQLite + FTS5 持久化**
- 内存 Store 全部替换为 `better-sqlite3` + Drizzle ORM
- 知识库接入 FTS5 全文检索（支持中文）
- gate budget（人工预算，默认 150 min/周）、意义闸合并、LLM 调用日志与成本统计全部落库

**M4 — 5 个前端页面**
- 开发者工具风格：冷色 slate + cyan 强调色，深色模式默认，等宽字体用于数字

**关键 API（节选）**
- `GET  /api/projects` / `/api/projects/:id/dashboard`
- `GET  /api/projects/:id/cycles` · `POST /api/cycles/:id/run-full` · `/api/cycles/:id/review`
- `GET  /api/human-gates` · `POST /api/human-gates/:id/approve|modify|reject`
- `GET  /api/knowledge?projectId=…` · `POST /api/knowledge/search`（body 用字段 `query`）
- `GET  /api/llm-calls/summary?projectId=…`

> 注意：重启后端前若要重置数据，删除项目根目录的 `data.db*` 文件即可（下次启动会重新 seed）。

> 提交仓库时不要提交 `data.db*`、`node_modules/` 或 `dist/`；根目录 `.gitignore` 已排除这些本地运行产物。

---

## 已修复的 8 个 PRD 漏洞

在算法落地过程中，对 PRD 原始设计暴露并修复了 8 个隐患（`alaya-core` 与 `alaya-app` 中均已修复）：

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| A | `compute_error` 无法处理「越小越好」指标 | 由 operator 推导方向因子 d |
| B | T=0 时除零 | scale 强制正下限 EPS |
| C | E_cycle 平方加权稀释大错 | 额外返回 worstClaimError + 关键 claim 权重 ≥3 |
| D | evidence_count 定义不自洽 | 统一为 (alpha-1)+(beta-1) |
| E | 灰区（0.3~0.7）死锁 | 灰区弱累加 + 连续灰区触发意义闸 + 人类/外部验证为主通道 |
| F | 衰减函数缺失 | score × exp(-λ × cyclesSinceValidated) |
| G | 离散 claim 不进 E_cycle | 所有可计算类型纳入 |
| H | 字段级写权限无机制 | event_log 记录 actor |

详见 [`Alaya_实现方案与架构评审.md`](./Alaya_实现方案与架构评审.md)。

---

## 接入真实 LLM

当前全程使用 mock LLM（确定性、可复现、零成本）。两个项目都通过 `LLMProvider` 接口隔离 LLM 调用，接真实 OpenAI/Anthropic 只需实现该接口并注入，业务逻辑零改动。

---

## 文档索引

| 文件 | 内容 |
| --- | --- |
| `Alaya_PRD.md` | 原始产品需求文档 |
| `Alaya_实现方案与架构评审.md` | 实现方案、架构评审、8 漏洞分析与验算 |
| `alaya-core/README.md` | 内核项目说明 |
| `alaya-app/BUILD_SPEC.md` | 全栈 MVP 构建规格 |
| `alaya-app/BUILD_REPORT.md` | 全栈 MVP 构建报告 |
