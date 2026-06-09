# Validation History and Long-Run Notes

This file preserves the detailed CI, long-run, and historical validation notes that used to live in the root README. Keep new durable validation summaries under this directory and link them from the README when they become part of the project status.

Related entry points:

- [README](../../README.md)
- [Configuration and operations](../configuration.md)
- [Current historical validation report](./VALIDATION_REPORT.md)

## CI 与本地长程验证

GitHub Actions 工作流位于 `.github/workflows/ci.yml` 和 `.github/workflows/deploy-readiness.yml`：

- `unit-and-integration`：安装 root/app/core 依赖，运行 guard、app focused regression、app full test、app typecheck、core test、core typecheck、script tests 和 core flywheel simulation。
- `live-llm-validation`：只在 `main` 分支 push 后尝试运行真实 LLM/GitHub live validation；缺少 secret 时明确跳过。
- `deploy-readiness`：默认不需要真实 secret，运行 secret scan、env/redaction/capability/health focused tests、pre-upgrade check、Docker build、shadow compose config 和 principles guard。

Actions secrets：

| Secret | 用途 |
| --- | --- |
| `LLM_API_KEY` | OpenAI-compatible provider key，可指向 MiniMax |
| `GH_PAT` | GitHub live sensor / issue E2E token |
| `OPENAI_BASE_URL` | 可选，默认 `https://api.minimax.io/openai` |
| `OPENAI_MODEL` | 可选，默认 `MiniMax-M3` |

24h fail-closed 本地验证脚本：

```bash
./scripts/24h_validation.sh
```

常用参数：

```bash
ALAYA_VALIDATION_DURATION_SECONDS=86400 \
ALAYA_VALIDATION_SLEEP_SECONDS=600 \
ALAYA_HEALTH_URL=http://127.0.0.1:5000/api/flywheel/health?projectId=... \
./scripts/24h_validation.sh
```

24h 脚本每轮运行 principles guard 和 mock flywheel simulation，每 3 轮尝试 live validation。缺少 secret 时标记 `SKIP`，有 secret 但 API 网络不可达时标记 `SKIP_NET`。如果 guard、simulation 或 live 步骤出现 `FAIL`，最终退出码为非零；连续 3 次 live failure 会提前停止。

12h 长程观测脚本：

```bash
./scripts/12h_validation.sh
```

常用参数：

```bash
ALAYA_VALIDATION_DURATION_SECONDS=43200 \
ALAYA_VALIDATION_SLEEP_SECONDS=600 \
ALAYA_VALIDATION_MAX_ROUNDS=72 \
./scripts/12h_validation.sh
```

12h 脚本用于长时间稳定性观察：principles guard 失败仍然立即停止；simulation、live、live connectivity `SKIP_NET` 和 flywheel health 属于非关键检查，同一检查项连续 3 次失败会写入 `alerts.log`，但不会中断 runner。连续计数按检查项独立维护，避免 health failure 被 unrelated live/sim success 清零。

12h/24h 验证脚本会先检查 `ALAYA_READY_URL`，默认 `http://localhost:5000/readyz`。如果没有现成服务且 `ALAYA_VALIDATION_START_APP=true`，脚本会启动 `npm run dev`，等待 `/readyz` 就绪后再进入 runner，确保 `/api/flywheel/health` 可读，`compoundingProof.round1vs4KnowledgeDelta` 不再因为健康 API 未启动而只能显示 `NA`。

### 匿名健康信号 36h 真实 LLM 验证

`npm run validation:health-signal` 用匿名穿戴健康硬件选型场景验证知识积累、冲突隔离、Human Gate 收敛和 Stall Guard。该流程不包含真实组织名或品牌名；默认项目名为 `wearable-health-signal-decision`，证据来源为 `health-signal-contradiction-runner`。

场景要求系统在 PPG、ECG、混合方案之间持续做传感器选型判断，并在相互矛盾的证据进入知识库前触发人工复核。默认配置为 36 小时、每 5 分钟采样一次、每个样本最多推进 6 个 scheduler tick，理论上最多 432 个样本。

启动真实 provider 长测：

```bash
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
PORT=5300 \
ALAYA_DB_PATH=$PWD/validation-logs/health-signal-36h/health-signal.db \
ALAYA_CAP_EXTERNAL_NOTIFICATION=true \
ALAYA_NOTIFICATION_PROVIDER=telegram \
ALAYA_TELEGRAM_BOT_TOKEN=<bot-token> \
ALAYA_TELEGRAM_CHAT_ID=<chat-id> \
npm run validation:health-signal
```

常用短窗口 smoke：

```bash
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
PORT=5300 \
ALAYA_DB_PATH=$PWD/validation-logs/health-signal-smoke/health-signal.db \
npm run validation:health-signal -- --duration-minutes=20 --sample-minutes=1 --max-samples=20
```

10h clean retest 需要先冻结代码基线：Goal 1-4 修复必须已经 commit，`git status --short` 必须为空，再用全新 DB 和明确端口启动。不要复用旧 `validation-logs/wonz-*` DB，也不要在已有 5300 旧 app/watchers 上直接续跑。

推荐启动方式是让 runner 按 Goal 4 guard 自己启动 app：

```bash
RUN_DIR=$PWD/validation-logs/health-signal-10h_$(date -u +%Y%m%d_%H%M%S)
mkdir -p "$RUN_DIR"

ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
PORT=5300 \
ALAYA_DB_PATH="$RUN_DIR/health-signal.db" \
npm run validation:health-signal -- \
  --duration-hours=10 \
  --sample-minutes=5 \
  --progress-ticks-per-sample=6 \
  --max-samples=120 \
  --resolve-conflict-reviews=0 \
  --log-dir="$RUN_DIR"
```

如果 app 已由独立固化脚本启动，则 runner 必须显式接入该 clean app，并且同样传入 guard env：

```bash
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
PORT=5300 \
ALAYA_DB_PATH="$RUN_DIR/health-signal.db" \
npm run validation:health-signal -- \
  --duration-hours=10 \
  --sample-minutes=5 \
  --progress-ticks-per-sample=6 \
  --max-samples=120 \
  --resolve-conflict-reviews=0 \
  --start-app=false \
  --base-url=http://127.0.0.1:5300 \
  --log-dir="$RUN_DIR"
```

`--resolve-conflict-reviews=0` 是 clean retest 的关键参数：runner 不再用占位 human proxy 自动 `quarantine` / `merge_supersede` 清空冲突复核，冲突会保持为 pending，交给真实人工或独立判断代理处理。这样才能验证 active 知识不会归零，以及语义矛盾不会被 repeated-meaning 自动批准旁路吞掉。

启动 guard 会在创建日志和启动 app 前拒绝脏环境：`ALAYA_SCHEDULER`、`ALAYA_AUTO_SEED_DEMO`、MiniMax provider 配置、`PORT` 和 `ALAYA_DB_PATH` 都必须显式传入；`OPENAI_API_KEY` 或非空 `OPENAI_API_KEY_FILE` 至少存在一个。可先用 dry-run 预检：

```bash
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
PORT=5300 \
ALAYA_DB_PATH=$PWD/validation-logs/health-signal-smoke/health-signal.db \
npm run validation:health-signal -- --check-only
```

app ready 后 runner 会调用 provider canary；只有返回 `ok=true`、`provider=openai` 且 `model=MiniMax-M3` 才会继续长测，返回 mock、错误模型或 canary 失败都会终止。清理端口时不要使用 `lsof -ti tcp:<port>` 批量 kill，这可能误杀 runner client；应先确认监听 PID，再只停止该监听进程。

runner 会写入：

| 文件 | 用途 |
| --- | --- |
| `monitor_log.csv` | 每个 sample 的 delta、active knowledge、gate、conflict review、`newGatesThisHour`、`llmTokenSource`、LLM 成本、RSS、cycle 和 Stall Guard 时序 |
| `events.jsonl` | provider canary、矛盾注入、scheduler tick、人审、冲突扫描、失败与重试事件 |
| `issues.md` | 长测中发现的具体工程问题和证据 |
| `summary.json` | 结束时的要求逐项判定和最终 drain 状态 |
| `timeseries_summary.json` | 时序窗口、Human Gate backlog、Stall Guard 触发率和事件计数 |
| `conflict_lifecycle_summary.json` | 矛盾注入、冲突扫描、复核解决和失败生命周期 |

长测结束或中途审计时刷新两个 summary：

```bash
npm run validation:health-signal:timeseries -- --log-dir validation-logs/<health-signal-run>
npm run validation:health-signal:conflicts -- --log-dir validation-logs/<health-signal-run>
```

最终判定口径：

| 指标 | 通过条件 | 说明 |
| --- | --- | --- |
| active 不归零 | 全程 `activeCount >= 1` 且终值 `>= 1` | `activeCount` 来自 `/api/flywheel/health.totals.activeKnowledgeCount`，不是临时脚本私算 |
| 语义矛盾隔离 | 对立证据被 `auto_approved_repeated_meaning` 旁路的比例为 0 | 带 `sampleReviewReason` 的 semantic/explicit contradiction gate 会被 runner 保留为 pending，不会被本地 proxy 批掉 |
| token 来源真实 | `token_source=provider` 占比 `>= 95%` | `monitor_log.csv` 的 `llmTokenSource` 和 `metrics_sample.llmTokenSourceStats` 用于抽查 MiniMax usage 是否真实落库 |
| 知识熵变 | `round1vs4KnowledgeDelta >= 8` | 该字段现在表示 round1 到当前知识量的增长；静态 round1-vs-round4 另存为 `round1vs4StaticKnowledgeDelta` |
| 冲突生命周期 | 累计冲突证据 `>= 5` 且已解决冲突复核 `>= 3` | 判定使用累计 review/event 证据，不再只看瞬时 `conflictCount`，避免快速解决后 CSV 点位显示 0 |
| Human Gate 收敛 | 后半段 pending gate 均值较前段下降 `>= 30%` | 早期全 0 backlog 时该指标会标记为不可判定 |
| Stall Guard | 触发数低于已关闭 cycle 的 5% | summary 会同时保留 raw 计数和基于明确事件/gate id 的 true trigger 计数 |
| 工程稳定性 | 无 `sample_failed`、`runner_crashed`、OOM、DB lock 或持续 request retry | 具体证据来自 `events.jsonl`、`app.log`、`runner.log` 和 `issues.md` |

Telegram 人审优先走真实本地 Telegram 卡片；如果桌面自动点击不可用，辅助脚本会先保留 Telegram 可见证据，再使用本地 API human proxy 处理 gate，并在 status JSON / API 队列中验证结果。知识冲突 risk gate 使用专门的 `quarantine` / `merge_supersede` 路径，不用普通 approve/reject 直接覆盖知识状态。

已知问题修复记录：

- 2026-06-09：已修复 P1 `knowledge_review_items.id` 主键冲突。resolved review 占用确定性 `kr_<hash>` 后，同一对知识再次被检测为冲突时会创建带单调后缀的新 review（例如 `kr_<hash>__r2`），保留 open review 复用语义，不再在 `POST /api/human-gates/:id/approve` 的对立证据转知识链路中触发 `UNIQUE constraint failed`。回归测试：`R1 resolved duplicate conflict review id re-detection creates suffixed review`、`R2 approving opposing evidence meaning gate succeeds after resolved duplicate review id exists`、`R3 open duplicate conflict review id re-detection reuses existing review`。
- 2026-06-09：同步修复 health-signal 复测中暴露的观测噪声：MiniMax/OpenAI-compatible provider 的 schema repair retry 对 orchestrator 仍使用完整 schema，避免 summary-only fallback 提前制造降级 gate；Telegram 知识复核按钮对长 reviewId 使用 compact callback token，避免 `BUTTON_DATA_INVALID`；知识复核 gate 被 `resolveKnowledgeReview()` 处理时会补写 `human_gate_items resolve` 事件，方便区分真实审批状态和 Telegram ack 失败。回归测试：`chat provider parses the last balanced JSON object from wrapped content`、`exact repair schema retry asks for full JSON instead of summary-only degradation`、`callback router resolves compact knowledge review tokens`。

GitHub Issue Sensor E2E 默认优先使用 sandbox 环境变量，避免污染真实项目：

```bash
ALAYA_E2E_GITHUB_SANDBOX_OWNER=<owner> \
ALAYA_E2E_GITHUB_SANDBOX_REPO=<repo> \
GH_PAT=<token> \
npm run e2e:github
```

完整链路覆盖：

```text
GitHub Issue 入库 -> Sensor Agent 提炼 -> Human Meaning Gate 推送 ->
人工批准 -> active knowledge -> 下轮 Cycle 知识注入
```

汇总最近一次验证：

```bash
npm run validation:summary
```

或指定路径：

```bash
npm run validation:summary -- validation-logs/<run>/SUMMARY.csv
```

## 验证记录

### 2026-06-10 health-signal 10h clean retest

本地正在运行一轮只读式 10 小时 MiniMax 复测，用于验证 2026-06-09 health-signal 修复在真实 provider、全新 SQLite DB 和独立 `PORT=5300` app 下是否成立。本条记录只说明当前验证入口，不代表最终通过结论。

冻结基线：

```text
870c319 Fix duplicate knowledge review id on re-detection after resolution
```

运行证据：

| 项目 | 路径或口径 |
| --- | --- |
| Run dir | `validation-logs/health-signal-10h_20260609_163552` |
| Project | `proj_mq6v45vj` |
| Provider | `ALAYA_LLM_PROVIDER=openai`, `OPENAI_BASE_URL=https://api.minimax.io/openai`, `OPENAI_MODEL=MiniMax-M3` |
| Runner | `--duration-hours=10 --sample-minutes=5 --progress-ticks-per-sample=6 --max-samples=120 --resolve-conflict-reviews=0 --start-app=false --base-url=http://127.0.0.1:5300` |
| Interim status | `validation-logs/health-signal-10h_20260609_163552/interim_status.md` |
| New issues | `validation-logs/health-signal-10h_20260609_163552/issues.md` |
| Final verdict | 等 `summary.json`、`timeseries_summary.json`、`conflict_lifecycle_summary.json` 和最终审计表生成后再记录 |

验证期间不修改产品代码、runner 脚本或测试；发现的新问题只写入本轮 `issues.md`，待 10 小时窗口收口后再按 8 项判定标准给出最终结论。

### 2026-06-10 P0 safety_mode deadlock repair

`health-signal-10h_20260609_163552` 在约 6 小时处暴露出 P0：`safety_mode` 对注意力/backlog 类状态执行全停，导致 `cyclesTotal` 长期卡在 1。当前修复把这类软安全态改为限速推进，同时保留 LLM 成本硬超预算、Builder 偏航、预测不可测、知识审计失败等硬安全闸的 `safety_mode` 早退。

可配置默认值：

| 配置项 | 默认值 | 用途 |
| --- | ---: | --- |
| `ALAYA_SAFETY_THROTTLE_EVERY_TICKS` | `2` | 软安全态下每 2 个 scheduler tick 允许 1 次推进，其余 tick 返回 `safety_throttled` 延迟执行。 |
| `ALAYA_FLYWHEEL_COMPOUNDING_WARMUP_CYCLES` | `3` | 前 3 个已关闭 cycle 作为复利证据 warmup；从第 4 轮开始才强制检查新方向是否证明前轮知识影响了本轮决策。 |

回归测试覆盖：

| 测试 | 断言 |
| --- | --- |
| `S1 safety_mode exits after blocking backlog is resolved and does not recreate human_attention_overload` | backlog 清空后 `gateBudgetForProject().safetyMode === false`，本周已关闭的 `human_attention_overload` 不会被重复创建。 |
| `S2 attention backlog safety_mode throttles but still advances cycles` | 注意力/backlog 类 safety mode 下 action 为 `safety_throttled`，并能在节流 tick 推进 `currentCycleIdx`。 |
| `S3 compounding guard warms up early cycles but still blocks multi-round zero compounding` | cycle 1 warmup 不触发飞轮空转闸；多轮零复利证据仍触发 `flywheel_empty_learning` 硬安全闸。 |
| `S4 hard safety guard still blocks builder misdirection without advancing` | Builder 偏航仍返回 `safety_mode`，不创建方向闸、不推进 cycle。 |

### 2026-06-07 roadmap gap closure

本次闭合路线图剩余 A-F 能力：知识冲突/复核、Builder Codex dry-run adapter、provider canary 与 LLM failure taxonomy、运营 KPI、业务信号导入和组织模块模板。完整证据见 [docs/validation/2026-06-07-roadmap-gap-closure.md](./2026-06-07-roadmap-gap-closure.md)。

已通过：

```bash
npm run guard
npm run typecheck
npm run test:all
npm run build
npm run benchmark:smoke
npm run flywheel
npm run e2e:long-evolution
npm run secret:scan
```

结果摘要：

| 项目 | 结果 |
| --- | --- |
| Focused roadmap tests | 42/42 PASS |
| Core tests | 52/52 PASS |
| App tests | 156/156 PASS |
| Script tests | 18/18 PASS |
| Benchmark smoke | 12/12 PASS |
| Long evolution E2E | 20 cycles PASS |
| Secret scan | PASS |

### 2026-06-07 P0/P1/P2 hardening validation

本次本地验证覆盖数学命门修复、GitHub Sensor 入库链路、四类自主停机风险闸、灰区弱累加三条主路径、Onboarding Claim operator 和 Cycle Review action ledger 可视化。

已通过：

```bash
npm run test:all
npm run typecheck
npm run build
npm run guard
```

结果摘要：

| 项目 | 结果 |
| --- | --- |
| Core tests | 52/52 PASS |
| App tests | 125/125 PASS |
| Script tests | 18/18 PASS |
| Typecheck | PASS |
| Production build | PASS |
| Principles guard | 17/17 PASS |

构建仍会输出一个既有 PostCSS `from` option warning，退出码为 0，不影响本次构建产物。

### 2026-06-05/06 12h real LLM validation

本地完成一次完整 12 小时长程验证，真实 LLM 路径接入 MiniMax OpenAI-compatible endpoint，GitHub API 连通性预检通过。

```bash
ALAYA_VALIDATION_DURATION_SECONDS=43200 \
ALAYA_VALIDATION_SLEEP_SECONDS=600 \
ALAYA_VALIDATION_MAX_ROUNDS=72 \
bash scripts/12h_validation.sh
```

结果摘要：

| 项目 | 结果 |
| --- | --- |
| 时间窗口 | 2026-06-05 17:53:53 - 2026-06-06 05:57:32 CST |
| 总时长 | 12h 03m 39s |
| 总轮次 | 69，12 小时时长门限先于 72 轮上限触发 |
| Principles guard | 69/69 PASS |
| Mock flywheel simulation | 69/69 PASS |
| Real LLM flywheel live | 23/23 PASS, rounds 3/6/.../69 |
| Planned live skips | 46 |
| Real LLM calls | 460 |
| Tokens | 280,935 |
| Estimated cost | 0.057997 USD |
| Alerts | 0 |
| Residual runner/process | 0 |
| Summary | `validation-logs/12h_20260605_175353/SUMMARY.csv` |
| Detailed report | `docs/validation/2026-06-06-12h-real-llm-validation.md` |

23 个 live 轮次均返回 `ok: true`，每次包含 `llmCalls.count=20`、`eventLogCount=56`、`decisionLogCount=4`。日志扫描未发现 `fetch failed`、`ETIMEDOUT`、`ECONNRESET`、`ENETUNREACH` 或 TCP 443 timeout 类失败。

认知迭代结论：在 `e2e:llm-flywheel` 验收范围内，4-cycle 多 Agent 飞轮可持续运行；后续 cycle 会引用前序知识改变决策，不重复 rejected direction，预测误差会回流到 distiller/world-model 更新，cycle 4 形成 rollback/audit 导向的新原则。这支持“核心设计符合预期、认知可持续迭代、知识库呈现熵减配平特征”的阶段性结论。

边界说明：本次验证不等同于完整 `npm run e2e:live` / GitHub issue sensor 业务链路通过。Health endpoint 未运行，23 次 health probe 均为空响应，`delta=NA`；本次熵减结论来自 live E2E 行为断言，而不是 health API 的 `compoundingProof.round1vs4KnowledgeDelta` 量化指标。

Post-run 修复：审计发现旧版 12h runner 的非关键失败计数是全局计数，health 连续失败会被 unrelated sim/live success 清零，导致三连 health alert 不触发。当前版本已改为按检查项独立计数，并用 9 轮 forced-failure smoke 验证：`live connectivity` 与 `flywheel health` 都在第 9 轮写入 alert，脚本仍正常完成。

### 2026-06-05 3h real LLM validation

本地使用 12h validation runner 压缩为 3 小时窗口完成一次真实 LLM 验证循环：

```bash
ALAYA_VALIDATION_DURATION_SECONDS=10800 \
ALAYA_VALIDATION_SLEEP_SECONDS=600 \
ALAYA_VALIDATION_MAX_ROUNDS=18 \
bash scripts/12h_validation.sh
```

结果摘要：

| 项目 | 结果 |
| --- | --- |
| 时间窗口 | 2026-06-05 07:45:06 - 10:45:29 CST |
| 总轮次 | 18 |
| Principles guard | 18/18 PASS |
| Mock flywheel simulation | 18/18 PASS |
| Real LLM flywheel live | 6/6 PASS, rounds 3/6/9/12/15/18 |
| Non-critical errors | 0 |
| Alerts | 0 |
| Summary | `validation-logs/12h_20260605_074506/SUMMARY.csv` |

6 个 live 轮次均返回 `ok: true`，每次包含 `llmCalls.count=20`，合计约 73,327 tokens，未出现 `fetch failed`、`ETIMEDOUT` 或 TCP 443 超时类错误。本机连通性检查中 MiniMax endpoint 可达，GitHub API 返回 HTTP 200。

边界说明：本次验证覆盖的是 `npm run e2e:llm-flywheel` 的真实 LLM 路径，并证明当前机器能访问真实模型端点；它不等同于完整 `npm run e2e:live` / GitHub issue sensor 端到端业务链路通过。GitHub 业务链路仍需单独跑完整 live E2E 验收。

最近本地验证覆盖：

- `npm run test:all`
- `npm run guard`
- `npm run typecheck`
- `npm run build`
- `npm run benchmark:smoke`
- `npm run flywheel`
- `npm run e2e:long-evolution`
- `npm run secret:scan`
- `npm run ops:migrate`
- Docker shadow migration + health/ready/metrics smoke
- `npm run e2e:ui-freeze`
- `cd alaya-app && node --import tsx --test tests/schema_migration.test.ts tests/update_confidence.decay.test.ts`
- `node --test scripts/tests/live-readiness.test.mjs`

知识库详情页稳定性修复已经过压力验证：在大量 Agent 引用记录下，`/api/knowledge/:id` 只返回有限引用，前端只渲染有限列表，并通过浏览器 smoke test 检查页面切换、知识搜索、详情点击和主线程长任务。

本次治理增强额外覆盖：

- 旧库已有 `knowledge_items` 在 FTS5 迁移后可被知识注入检索。
- Scheduler tick 会自动执行 stale knowledge 时间衰减，并通过 `lastDecayedAt` 避免重复衰减同一时间区间。
- `/health` 页面按当前项目查询 flywheel health 和 pending gates。
- 24h 验证脚本在任何 FAIL 后以非零退出码结束。
- Telegram P0/P1 覆盖单向通知、双向卡片、MarkdownV2 转义、callback 审批审计、gateId 去重、long-polling offset、`/status`/`/gates` 命令和真实 Bot API 发送 smoke。

已知构建提示：

- 当前构建可能出现一个 PostCSS `from` 选项提示，不影响本地构建结果。
