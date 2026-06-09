# Configuration and Operations

This file preserves the detailed runtime, configuration, operations, API, and feature notes that used to live in the root README. The README now stays focused on orientation and quick start.

Related entry points:

- [README](../README.md)
- [PRINCIPLES](../PRINCIPLES.md)
- [Validation history](./validation/validation-history.md)
- [Ops docs](./ops/00-baseline-audit.md)

## 核心概念

### 1. Flywheel

每一轮 cycle 都会经历：

```text
预测 -> 行动 -> 观察 -> 误差归因 -> 知识沉淀 -> 下一轮引用
```

第 3 轮必须被前两轮知识真实改变，而不是形式上引用。第 4 轮继续要求产出 rollback-ready change package 和 audit summary。第 5 轮起，如果脚本化场景已经用尽，Scheduler 会生成新的自主目标，而不是复用最后一轮模板或停止在场景耗尽状态。

### 2. Five Agents

| Agent | 作用 |
| --- | --- |
| Orchestrator | 选择本轮目标、引用知识、提出预测与动作 |
| Sensor | 收集反馈和外部信号 |
| Builder | 形成任务或变更包 |
| Distiller | 把观察与误差提炼成知识 |
| Librarian | 管理知识状态、晋级、过期、冲突和隔离 |

### 3. Human Gates

系统内置三类闸门：

- Direction gate：方向是否允许执行
- Meaning gate：信号是否值得进入知识循环
- Risk gate：风险、成本、阻断条件是否需要人工处理

Human Gate 可以在 Web UI 中处理，也可以通过 Telegram 接收移动端通知。非阻塞 `meaning` gate 会在 Telegram 卡片中显示批准/否决按钮；阻塞型 `direction` / `risk` gate 只显示 Web 深链，避免手机端一键放行高风险阻断闸。

Meaning Gate 被批准后，`HumanGateService` 会把对应外部信号写成 active knowledge，并通过同一条审批服务记录 `decision_log`、`event_log` 和 `action_ledger`。Gate resolve 与知识写入在数据库事务中执行；如果知识写入失败，gate 不会被错误地标记为已批准，后续重试也会幂等补建缺失知识。

### 4. Prediction Ledger

每个 claim 都要能被观测和计算误差。系统不会把「感觉变好」当作成功证明，而是保存目标、实际值、误差、归因和修正动作。

`metric_threshold` claim 的核心契约：

- `operator` 必填且只能是 `>=` 或 `<=`。误差方向因子由 `operator` 推导：`>=` 表示越大越好，`<=` 表示越小越好；调用方不再手填方向。
- `scale` 如提供必须 `>= 1e-6`；未提供时使用 `max(abs(target), 1e-6)`，避免 target 为 0 时除零。
- `metric_threshold` 的 `weight` 必须至少为 3；`E_cycle` 计算也会在 compute 层强制关键指标权重下限，避免大量低价值预测稀释关键失败。
- `E_cycle` 同时输出 `worstClaimError`，用于连续两轮关键 claim 超阈值的单独判定。

所有可测 claim，包括 `metric_threshold`、`binary`、`categorical` 和 `directional`，都可以携带预测契约字段：

```text
expectedObservation
timeWindow
successThreshold
failureThreshold
uncertainty
```

Scheduler 会用这些字段判断预测是否能成为可靠学习信号。New Project 的 Onboarding Interview 强制用户设置首条可测 claim 的指标、operator 和目标阈值；Project Setup 可后续调整，但同样只允许 `>=` / `<=`。

### 5. Knowledge Base

知识不是普通笔记。每条知识都有置信度、状态、来源、引用记录、有效期和治理字段。过期、冲突或未经验证的知识不能无条件支撑下一轮决策。

Librarian 会对近义知识做熵减合并：保留主条目，给被合并条目写入 `supersededBy`，不做物理删除。检索和高风险证据集默认排除 stale、quarantined、conflict 和 superseded 条目。

任务前知识注入由 `alaya-app/server/knowledgeInjection.ts` 负责：系统根据当前任务文本从 FTS5 检索 active/strong 且未被 supersede 的知识，构造有上限的 `[PRIOR KNOWLEDGE]` 上下文并写回 `usageCount`、`lastInjectedAt` 和审计事件。显式 schema migration 会执行 FTS5 `rebuild`，确保旧库已有知识也能被新建索引检索到；shadow/staging/production 的常态启动只校验 schema readiness。

时间衰减由 `applyTimeDecay` 和 Scheduler 共同执行。`lastVerifiedAt` 保留真实验证时间，`lastDecayedAt` 记录最近一次自动衰减时间，避免周期性 tick 对同一历史区间重复衰减。被衰减到阈值以下的知识会降级为 stale，并通过 `time_decay_scheduler` 写入审计日志。

## 自主进化与长期验证

Alaya 的默认 4 轮场景仍然作为治理回归基线保留。超过第 4 轮后，系统会基于当前项目身份、世界模型、已验证知识、上轮误差和近期反馈生成下一轮目标。

自主进化有四类停机风险闸：

- `evolution_stalled`：连续误差不改善。
- `goal_repetition`：新目标与历史目标或被拒方向重复。
- `maturation_stall`：决策知识增长但 strong 知识不成熟。
- `knowledge_explosion`：可决策知识规模异常增长。

长程离线验证：

```bash
npm run e2e:long-evolution
```

该脚本会跑 20 轮 mock LLM 飞轮，检查不再出现 `scenario_exhausted`、目标不重复、知识规模有界、合并事件有审计记录、blocking gate 不膨胀。

## Web 功能地图

| 页面 | 作用 |
| --- | --- |
| Dashboard | 当前项目、cycle、风险、预算、最近知识 |
| Human Gates | 批准、修改或否决方向闸、意义闸、风险闸 |
| Prediction Ledger | 查看预测、观察、误差和归因 |
| Knowledge Base | 搜索知识、查看置信度、来源和 Agent 引用 |
| Cycle Review | 复盘单轮 cycle、Agent 输出、复利证据和本轮高风险 action ledger 时间线 |
| Flywheel Health | 查看每轮新增知识、晋级、纠错、知识注入、知识状态和复利证明 |
| New Project | Onboarding Interview，创建新项目 |
| Project Setup | 修正 seed identity、world model、redlines 和第一轮 claim |

## Telegram 移动端通知与审批

Telegram 集成让 Alaya 在手机上主动提醒用户：有 blocking gate、safety mode 或 pending Human Gate 时，不需要一直打开桌面浏览器。实现位于 `alaya-app/server/notifications/`，由 `scheduler.ts` 懒加载 `NotificationBus` 与 `TelegramAdapter`。

### 功能范围

| 场景 | 行为 |
| --- | --- |
| Scheduler 新建 pending gate | 推送 Telegram 卡片；按 `gateId` 去重，避免每个 tick 重复通知；深链携带 `projectId` 和 `gate` |
| 普通 `meaning` / `direction` / `risk` gate | 卡片显示 `✅ 批准` / `❌ 否决`，点击后统一走 `HumanGateService`，写入 `decision_log`、`event_log` 和 `action_ledger` |
| 知识冲突复核 gate | 卡片显示 `✅ 隔离当前` / `↔️ 保留既有`，通过 `resolveKnowledgeReview` 收敛冲突，并保留 Web 详情入口 |
| Safety mode | 推送纯文本通知，包含项目、原因和 Web UI 链接 |
| `/status` | 返回所有项目的当前 cycle、pending gates、知识数和最后事件时间 |
| `/gates` | 列出所有 pending gates；可直接处理普通 Human Gate，并给知识冲突复核提供专门按钮 |
| `/help` | 返回可用命令 |

### 本地配置

复制并编辑本地 env。不要提交真实 token：

```bash
cp alaya-app/.env.example alaya-app/.env
```

最小配置：

```bash
ALAYA_CAP_EXTERNAL_NOTIFICATION=true
ALAYA_NOTIFICATION_PROVIDER=telegram
ALAYA_TELEGRAM_BOT_TOKEN=<BotFather token>
ALAYA_TELEGRAM_CHAT_ID=<your chat id>
ALAYA_BASE_URL=http://localhost:5000
ALAYA_ALLOWED_NETWORK_HOSTS=api.github.com,api.openai.com,api.minimax.io,api.minimaxi.com,api.telegram.org
```

如果 5000 端口被占用：

```bash
PORT=5001
ALAYA_BASE_URL=http://localhost:5001
```

启动：

```bash
npm --prefix alaya-app run dev
```

打开 Web UI：

```text
http://localhost:5001/#/human-gates
```

### 获取 Telegram Chat ID

1. 在 Telegram 里找 `@BotFather` 创建 bot，拿到 token。
2. 给 bot 发任意消息。
3. 请求 `https://api.telegram.org/bot<TOKEN>/getUpdates`。
4. 在返回 JSON 中找到 `message.chat.id`，填入 `ALAYA_TELEGRAM_CHAT_ID`。

Bot 可选命令菜单：

```text
status - 查看飞轮当前状态
gates - 列出所有待处理闸门
help - 查看使用帮助
```

### 安全与审计

- 所有出站 Telegram 请求必须同时通过 `ALAYA_CAP_EXTERNAL_NOTIFICATION` 和 `ALAYA_ALLOWED_NETWORK_HOSTS`。
- 网络 host 固定校验为 `api.telegram.org`；token 格式会在 adapter 构造时验证。
- 使用原生 `fetch` 调 Telegram Bot API，不引入 `node-telegram-bot-api`，避免其历史依赖链中的 critical audit 漏洞。
- Telegram callback 不直接写 `storage.updateGate`；批准/否决统一走 `HumanGateService`，保留 capability gate、运行模式、事件日志和 action ledger。
- 冲突复核 callback 不绕过知识状态机；`quarantine` 与 `merge_supersede` 统一走 `resolveKnowledgeReview`，已处理卡片会回填详细决策回执。
- Long polling 的 update offset 持久化到 `telegram-update-offset.json`，该文件已加入 `alaya-app/.gitignore`。
- 所有 Telegram MarkdownV2 文本都会转义动态内容；通知失败只记录错误，不阻塞 Scheduler 主流程。Telegram API 仅对网络错误、408、429 和 5xx 做短重试，400/403 等非临时错误会快速失败，避免拖慢人审链路。

## P0/P1 证据化内核

本轮 P0/P1 在本地 SQLite 架构上增加可追踪、可评测、可审计的证据层，不依赖外部 OTel 或 LangSmith 服务。

- `trace_events` 记录 OTel-compatible 的 cycle state、agent run、LLM call、knowledge injection、error classification、principle transition、approval 和 action risk 事件；`event_log` 保留为原有审计流。
- `action_ledger` 记录高风险动作的 risk level、approval gate、rollback plan、audit summary 和 idempotency key。只有 `approved` direction gate，或与该动作 idempotency key 匹配的 `approved` risk gate，才能放行需要审批的动作；`pending`、`modified`、`rejected` 都不会被视为批准。
- `RiskLevel` 分为 `read_only`、`draft_only`、`local_write`、`external_write`、`destructive`、`financial`、`compliance_sensitive`。内部 local write 默认可免审批；external/destructive/financial/compliance-sensitive 必须经过 gate。
- Model router 默认沿用 `ALAYA_LLM_PROVIDER` / `OPENAI_MODEL`，也支持 `ALAYA_MODEL_ROUTING_JSON` 和 role-specific env override；`llm_calls` 会记录 provider/model/route reason。
- `npm run benchmark:smoke` 使用 deterministic mock cases 覆盖 round4、knowledge injection、rollback package、source reliability、principle decay、prompt injection、action risk、model routing 和 trace completeness。

## 常用命令

从仓库根目录运行：

```bash
npm run test:all       # core + app + scripts 测试
npm run guard          # 治理底线守卫
npm run typecheck      # core + app 类型检查
npm run build          # Web app 生产构建
npm run flywheel            # 4 轮飞轮模拟
npm run e2e:long-evolution  # 20 轮自主进化离线验收
npm run e2e:github          # GitHub Issue Sensor 完整链路，建议指向 sandbox repo
npm run e2e:github-autonomous # 自主调度 + GitHub Sensor 完整链路
npm run benchmark:smoke      # P0/P1 deterministic benchmark
npm run provider:canary -- --projectId <projectId> --provider mock  # provider/model/role canary
npm run trace:export -- --cycle <cycleId>  # 导出 cycle trace JSONL
npm run audit:upgrade       # 升级 readiness 审计
npm run validation:summary  # 汇总 validation-logs 下最新 SUMMARY.csv
npm run validation:health-signal  # 匿名健康硬件选型 36h 真实 LLM 长测 runner
npm run validation:health-signal:timeseries -- --log-dir validation-logs/<run>  # 生成 timeseries_summary.json
npm run validation:health-signal:conflicts -- --log-dir validation-logs/<run>    # 生成 conflict_lifecycle_summary.json
npm run secret:scan         # 高置信 secret 扫描
npm run ops:pre-upgrade     # 升级前状态检查
npm run ops:backup          # SQLite state 备份
npm run ops:migrate         # 显式 schema migration
npm run ops:restore -- --backup tmp/alaya-backups/<backup>  # 默认 dry-run 恢复
npm run ops:post-upgrade    # 升级后 guard/core/probe 验证
npm run shadow:report -- --out tmp/shadow-report.md
```

TypeScript 运行入口统一使用 `node --import tsx`。这避免在受限环境里直接调用 `tsx` CLI 时创建 IPC pipe 失败，同时保留同样的 TS/ESM 加载能力。核心入口包括 app dev/build、core flywheel、真实 LLM E2E 和长程自主进化 E2E。

## 运行模式与安全模型

Alaya 现在有明确的运行模式。模式由 `ALAYA_MODE` 控制；如果未设置，`NODE_ENV=test` 映射到 `test`，`NODE_ENV=production` 映射到 `production`，其他情况默认为 `development`。

| 模式 | 典型用途 | 默认安全策略 |
| --- | --- | --- |
| `development` | 本地开发、快速调试 | 允许本地写和 mock LLM；外部真实写仍需显式路径 |
| `test` | 单元测试、集成测试 | 不需要真实外部 secret；测试 fixture 可以使用安全假值 |
| `shadow` | 影子运行、只观察不真实写 | 非只读 API 默认 dry-run；写入意图进入 `action_ledger` |
| `staging` | 受控预发 | 高风险能力默认 deny，需要显式 capability flag |
| `production` | 生产长期运行 | env fail-fast；demo seed 禁用；高风险能力最小权限 |

### API 鉴权与内置 UI

`/api/*` 在 `shadow`、`staging`、`production` 中默认需要 API key。服务端接受两种等价形式：

```bash
Authorization: Bearer $ALAYA_API_KEY
X-Alaya-API-Key: $ALAYA_API_KEY
```

`development` 和 `test` 只有在设置了 `ALAYA_API_KEY` 或 `ALAYA_REQUIRE_API_AUTH=true` 时才强制鉴权。`/healthz` 与 `/readyz` 不需要 API key；`/metrics` 使用 loopback/CIDR allowlist 单独保护。

内置 React UI 不会把 API key 打进 bundle，也不会从服务端公开读取 key。生产或 shadow 静态 UI 打开后，在左侧 Project 区域的 `API Key` 输入框填入 key 并保存；前端会把 key 保存在当前浏览器 tab 的 `sessionStorage`，并自动为 React Query、`apiRequest()` 和手写 API fetch 加上 `Authorization: Bearer ...`。关闭 tab 后需要重新输入。点击“清除”会移除本 tab 的 key 并刷新查询。

命令行检查：

```bash
curl -fsS http://127.0.0.1:5000/healthz
curl -fsS -H "Authorization: Bearer $ALAYA_API_KEY" http://127.0.0.1:5000/api/projects
```

`shadow`、`staging`、`production` 缺少 `ALAYA_API_KEY` 会在 env validation 阶段 fail fast。这样不会出现 `/readyz` 看起来正常、但所有 `/api/*` 请求返回 `503 api authentication is not configured` 的半可用状态。

Capability gate 覆盖高风险动作。所有 flag 都通过环境变量开启，默认不要在长期运行里打开。

| Capability | Env | 默认 long-run 行为 | 当前接入点 |
| --- | --- | --- | --- |
| filesystem write | `ALAYA_CAP_FILESYSTEM_WRITE` | deny | 预留给本地写 adapter；shadow API 兜底 dry-run |
| shell execution | `ALAYA_CAP_SHELL_EXECUTION` | deny | 当前业务未接 shell adapter；若新增必须先 gate |
| GitHub write | `ALAYA_CAP_GITHUB_WRITE` | deny | 当前 GitHub 路径只读 issue sensor；写 adapter 必须先 gate |
| database migration | `ALAYA_CAP_DATABASE_MIGRATION` | deny | 只用于显式 `ops:migrate` / `dist/migrate.cjs` |
| unknown network | `ALAYA_CAP_NETWORK_UNKNOWN` | deny | LLM/OpenAI-compatible fetch 与 GitHub fetch 之前检查 |
| LLM call | `ALAYA_CAP_LLM_CALL` | deny in production unless enabled | `callLlm()` 的真实 provider 路径 |
| knowledge write | `ALAYA_CAP_KNOWLEDGE_WRITE` | shadow dry-run, staging/prod deny | 非只读 API、知识/项目/cycle/反馈写路径 |
| scheduler loop | `ALAYA_CAP_SCHEDULER_LOOP` | deny | `startCycleScheduler()` 启动前检查 |
| external notification | `ALAYA_CAP_EXTERNAL_NOTIFICATION` | deny | Telegram `sendMessage`、`editMessageText`、`answerCallbackQuery`、`getUpdates` 等出站通知路径 |

Shadow 模式下，`POST /api/knowledge` 这类 mutating API 会返回：

```json
{
  "status": "dry_run",
  "mode": "shadow",
  "capability": "knowledge_write",
  "target": "POST /knowledge"
}
```

同时 `action_ledger` 会写入 `capability.knowledge_write`，`status=dry_run`，包含 actor、mode、capability、target、input hash、结果和时间戳。handler 不会执行真实写入。

生产模式下，相同的默认行为是 `403`，除非显式设置对应 capability。这个设计避免“只在测试里测 gate，但真实路由没接入”的假通过。

高成本端点限速：

```text
ALAYA_COST_RATE_LIMIT_WINDOW_MS=60000
ALAYA_COST_RATE_LIMIT_MAX=10
```

如果这两个变量被误写成非数字，运行时会回退到默认值而不是关闭 limiter。`POST /api/cycles/:id/run-full` 和 `POST /api/scheduler/tick` 都走这个保护；`/healthz`、`/readyz`、`/metrics` 不受高成本限速影响。

## 数据库迁移、备份与恢复

开发和测试模式可以在启动时自动创建/补齐 SQLite schema。`shadow`、`staging`、`production` 的稳态启动不会静默执行 DDL；如果 schema 缺表或缺关键列，启动会 fail fast，提示运行显式迁移。

本地迁移流程：

```bash
npm run ops:pre-upgrade
npm run ops:backup
ALAYA_CAP_DATABASE_MIGRATION=true npm run ops:migrate
npm run ops:post-upgrade
```

`ops:migrate` 会运行 `alaya-app/server/migrate.ts`。生产构建后对应入口是 `dist/migrate.cjs`，Docker shadow 初始化使用这个入口。

备份：

```bash
npm run ops:backup
```

默认输出到：

```text
tmp/alaya-backups/backup-<timestamp>/
```

备份内容包括 SQLite DB 和 WAL/SHM sidecar。脚本会写 `manifest.json`，只记录出现过的 env 变量名，不记录 env 值；`.env` 和 secret 文件不会被备份。

恢复默认是 dry-run：

```bash
npm run ops:restore -- --backup tmp/alaya-backups/<backup-dir>
```

确认恢复前必须停止服务，然后显式加 `--confirm`：

```bash
npm run ops:restore -- --backup tmp/alaya-backups/<backup-dir> --confirm
```

SQLite 备份一致性在服务停止或 WAL checkpoint 后最强。生产/长期 shadow 运行前应先停服务或确认没有活跃写入，再做关键备份。

## Docker Shadow 部署与 smoke 验证

本节是短 smoke，不是 7 天 shadow run。7 天 shadow run 文档在 [docs/ops/05-shadow-run-7d.md](./ops/05-shadow-run-7d.md)，本次不自动执行。

构建镜像：

```bash
docker build -t alaya:local .
docker tag alaya:local alaya:shadow
```

渲染 compose：

```bash
docker compose -f deploy/docker-compose.shadow.yml config
```

第一次使用新的 shadow volume，或升级后需要 schema 变更时，先运行一次显式迁移：

```bash
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml run --rm \
  -e ALAYA_CAP_DATABASE_MIGRATION=true \
  alaya node dist/migrate.cjs
```

正常启动保持 `ALAYA_CAP_DATABASE_MIGRATION=false`：

```bash
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml up -d --no-build
curl -fsS http://localhost:5055/healthz
curl -fsS http://localhost:5055/readyz
curl -fsS http://localhost:5055/metrics
```

证明 shadow 写操作不会真实执行：

```bash
curl -fsS -X POST http://localhost:5055/api/knowledge \
  -H 'Content-Type: application/json' \
  --data '{"id":"kb_shadow_probe","projectId":"proj_shadow","title":"probe","content":"dry run only"}'

curl -fsS 'http://localhost:5055/api/action-ledger?limit=5'
```

预期：第一个请求返回 `202 dry_run`；第二个请求能看到 `capability.knowledge_write` 且 `status=dry_run`。

停止：

```bash
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml down
```

容器安全属性：

- Dockerfile 使用 `node:20-bookworm-slim`，没有 `latest`。
- build/runtime 分阶段，runtime 运行用户是 `alaya`，不是 root。
- `.dockerignore` 排除 `.env`、数据库、日志、缓存、tmp、coverage、node_modules 和 `.git`。
- compose 使用 read-only root filesystem。
- 可写位置限制在 named volumes：`/var/lib/alaya`、`/var/log/alaya`、`/var/cache/alaya`。
- shadow compose 不挂载宿主根目录，不使用 privileged。

## 可观测性与审计账本

运行端点：

```text
GET /healthz   # 进程活着，尽量不因依赖失败而 500
GET /readyz    # 配置、数据库、关键目录可写性、schema readiness
GET /metrics   # Prometheus text
```

`/metrics` 包含：

```text
alaya_uptime_seconds
alaya_mode_info
alaya_scheduler_cycles_total
alaya_scheduler_cycle_duration_ms
alaya_actions_total
alaya_actions_denied_total
alaya_capability_denials_total
alaya_llm_requests_total
alaya_llm_tokens_input_total
alaya_llm_tokens_output_total
alaya_llm_estimated_cost_usd_total
alaya_external_feedback_items_total
alaya_knowledge_injections_total
alaya_stall_events_total
alaya_errors_total
alaya_last_successful_cycle_timestamp
alaya_llm_agent_latency_p50_ms{agent=...}
alaya_llm_agent_latency_p95_ms{agent=...}
alaya_llm_agent_error_rate{agent=...}
```

LLM 调用现在同时保存：

- `input_token_count`
- `output_token_count`
- `token_count`
- `estimated_cost`
- `llm_failure_type`：`timeout`、`rate_limit`、`auth`、`schema_error`、`invalid_json`、`safety_refusal`、`network`、`provider_error`、`unknown`

前端 Ledger、`/api/llm-calls/summary`、`/api/llm-calls/latency` 和 `/metrics?format=json` 都能用于核对 input/output split、失败类型和分 Agent latency。聚合值可以从 `llm_calls` 与 `trace_events` 原始记录交叉核对。

审计持久化：

- `event_log`：storage 写路径的 before/after diagnostics，写入前脱敏。
- `trace_events`：cycle、agent、LLM、知识注入、风险动作等 OTel-compatible trace，attributes 写入前脱敏。
- `action_ledger`：高风险动作和 capability decision，包含 status、risk、approval gate、rollback plan、payload 和 idempotency key，payload/audit/rollback 写入前脱敏。

脱敏覆盖 bearer token、Cookie/Set-Cookie、GitHub/OpenAI/Slack token、AWS key id、数据库 URL 密码、private key block、email、明显 phone number，以及对象中 `apiKey/token/secret/password/database_url` 等 secret-like key。Phone redaction 需要至少 10 位数字并带有 `+` 或多个分隔符，因此普通日期如 `2026-06-06`、分组编号如 `1234-5678` 会保留上下文，不会被误替换为 `[redacted-phone]`。

Web 开发：

```bash
npm run dev
```

UI 卡顿回归测试需要先启动 Web 服务。默认检测 `http://127.0.0.1:5001`。

终端 A：

```bash
PORT=5001 npm run dev
```

终端 B：

```bash
npm run e2e:ui-freeze
```

如需指定地址：

```bash
ALAYA_E2E_BASE_URL=http://127.0.0.1:5000 npm run e2e:ui-freeze
```

完整 live 验收会调用真实 LLM 和 GitHub，需要本机 secret：

```bash
npm run e2e:live
```

`alaya-app` 内也提供同名代理入口，供 CI 和脚本在 app 工作目录中调用：

```bash
npm --prefix alaya-app run flywheel:live
```

## 真实 LLM 与 Secret

默认不调用真实模型。启用 OpenAI-compatible provider：

```bash
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY=... \
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_MODEL=gpt-4.1-mini \
npm run dev
```

MiniMax 等兼容端点可通过 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 切换。

为了避免把 key 写入 shell history，可以使用本地 key file：

```bash
npm run setup:secrets
npm run setup:secrets:check
```

该工具默认只写用户配置目录，也可用 `OPENAI_API_KEY_FILE` / `GITHUB_TOKEN_FILE`
显式指定其他本地路径：

```text
$HOME/.config/alaya/openai-api-key
$HOME/.config/alaya/github-token
```

文件权限为 `0600`，不会打印 secret 值。

GitHub Actions 中请添加 `LLM_API_KEY` 和 `GH_PAT` 两个 Secrets。不要自定义名为
`GITHUB_TOKEN` 的 Secret；这是 GitHub Actions 的保留令牌名。

真实 LLM preflight：

```bash
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
npm run e2e:llm
```

`ALAYA_E2E_ALLOW_SKIP=true` 只在没有可用 key 时允许跳过真实调用；如果本机存在 key 但 key 无效，E2E 会 fail closed 并显示 provider 返回的错误。

真实 4 轮飞轮：

```bash
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
npm run e2e:llm-flywheel
```

## 本地数据

默认配置：

```text
PORT=5000
HOST=0.0.0.0
REUSE_PORT=false
ALAYA_BASE_URL=http://localhost:5000
ALAYA_CAP_EXTERNAL_NOTIFICATION=false
ALAYA_NOTIFICATION_PROVIDER=telegram
ALAYA_TELEGRAM_BOT_TOKEN=
ALAYA_TELEGRAM_CHAT_ID=
```

可复制 `alaya-app/.env.example` 后按需修改。

运行后生成：

```text
alaya-app/data.db
alaya-app/data.db-shm
alaya-app/data.db-wal
```

这些文件不会提交到仓库。需要重置演示数据时，停止服务后删除 `alaya-app/data.db*`，再重新启动。

## API 概览

核心 API：

```text
GET  /api/projects
POST /api/projects
PATCH /api/projects/:id
GET  /api/projects/:id/dashboard
GET  /api/flywheel/health?projectId=...
GET  /api/projects/:id/cycles
GET  /api/projects/:id/predictions
POST /api/predictions
POST /api/projects/:id/scheduler/tick
POST /api/scheduler/tick

GET  /api/human-gates
POST /api/human-gates/:id/approve
POST /api/human-gates/:id/modify
POST /api/human-gates/:id/reject

GET  /api/knowledge?projectId=...
GET  /api/knowledge/:id
POST /api/knowledge/search
POST /api/knowledge/:id/approve
POST /api/knowledge/:id/quarantine
GET  /api/projects/:id/knowledge-reviews
POST /api/projects/:id/knowledge/conflicts/scan
POST /api/projects/:id/knowledge/review-reminders
POST /api/knowledge-reviews/:id/resolve

GET  /api/cycles/:id/review
GET  /api/cycles/:id/traces
GET  /api/projects/:id/traces?limit=...
POST /api/cycles/:id/run-full
GET  /api/llm-calls/summary?projectId=...
GET  /api/llm-calls/latency
GET  /api/projects/:id/ops-metrics
POST /api/projects/:id/provider-canary

GET  /api/projects/:id/org-modules
POST /api/projects/:id/org-modules
GET  /api/org-modules/:id
PATCH /api/org-modules/:id
DELETE /api/org-modules/:id
GET  /api/org-modules/:id/markdown
POST /api/org-modules/:id/knowledge
```

外部反馈与集成：

```text
GET  /api/projects/:id/integrations
POST /api/projects/:id/integrations/github
POST /api/projects/:id/integrations/github/issues/sync
POST /api/projects/:id/feedback/form
GET  /api/projects/:id/business-signals
POST /api/projects/:id/business-signals/import
POST /api/projects/:id/builder/codex/plan
POST /api/builder/codex/apply
```

实现入口：

- `alaya-app/server/routes.ts`
- `alaya-app/server/storage.ts`
- `alaya-app/server/flywheel.ts`
- `alaya-app/server/scheduler.ts`
- `alaya-app/server/externalFeedback.ts`
- `alaya-app/server/businessSignals.ts`
- `alaya-app/server/knowledgeReview.ts`
- `alaya-app/server/builderAdapter.ts`
- `alaya-app/server/providerCanary.ts`
- `alaya-app/server/opsMetrics.ts`
- `alaya-app/server/orgModules.ts`
- `alaya-app/server/notifications/`
- `alaya-app/server/humanGateService.ts`

契约要点：

- `POST /api/projects` 使用 onboarding schema，必须提供 `firstClaimMetric`、`firstClaimOperator` 和 `firstClaimTarget`；`firstClaimOperator` 只允许 `>=` / `<=`。
- `PATCH /api/projects/:id` 的 `redlines` 字段是字符串数组；服务端负责持久化为 JSON 字符串。
- `POST /api/predictions` 的 `claims` 字段走统一 `claimSchema`，会拒绝缺失 operator、`operator ==`、`scale=0` 和 metric weight 小于 3 的关键指标 claim。
- `GET /api/cycles/:id/review` 返回 `actionLedger`，前端 Cycle Review 用它展示本轮高风险动作时间线。
- Business Signal import 会强制使用 URL project id 覆盖 body 内的 `projectId`，敏感信号写入审计前脱敏，并只创建 feedback + Meaning Gate。
- Builder Codex apply 默认 dry-run；`dryRun:false` 在 long-run mode 下归类为 `shell_execution`，默认拒绝，且即使审批通过也只记录 manual apply path。
- Provider canary 在 long-run mode 下归类为 `llm_call`，真实 provider 需要显式 capability 与 secret；mock canary 可用于本地和 CI。

## 路线图

| 项目 | 状态 | 入口 |
| --- | --- | --- |
| 知识冲突检测、过期提醒和复核任务 | 已完成 | `POST /api/projects/:id/knowledge/conflicts/scan`、`POST /api/projects/:id/knowledge/review-reminders`、`POST /api/knowledge-reviews/:id/resolve` |
| Builder Codex/Codex CLI 变更包 adapter | 已完成 dry-run MVP | `POST /api/projects/:id/builder/codex/plan`、`POST /api/builder/codex/apply`；非 dry-run apply 需要 shell capability + 匹配 idempotency risk gate |
| Provider canary、分 Agent latency 和 LLM 失败恢复分类 | 已完成 | `POST /api/projects/:id/provider-canary`、`npm run provider:canary`、`GET /api/llm-calls/latency`、`/metrics?format=json` |
| 真实使用运营指标 | 已完成 API MVP | `GET /api/projects/:id/ops-metrics`，覆盖 gate resolution、LLM cost、measurable claim ratio、knowledge reuse、blocking backlog、compounding gain proxy |
| 通用业务信号 Sensor adapter | 已完成 CSV/JSON 本地导入 MVP | `POST /api/projects/:id/business-signals/import`，详见 [docs/business-signals.md](./business-signals.md) |
| 组织模块知识模板 | 已完成 API MVP | `GET/POST /api/projects/:id/org-modules`、Markdown export、draft knowledge conversion，详见 [docs/org-modules.md](./org-modules.md) |
