# Alaya 认知增强 · 知识飞轮消融实验 · 预注册

> **预注册时间戳**：2026-07-09 Asia/Shanghai，PR-L0 content-freeze commit 的 git timestamp 为准。
> **PR-L0 content_freeze_commit**：TBD_CONTENT_FREEZE_COMMIT
> **后续代码/度量冻结锚点**：TBD_AFTER_PR_L6_MAIN_MERGE（PR-L6 合并到 `main` 后填写；不得与 PR-L0 content freeze 混同）
> **分支**：`codex/learning-loop`
> **PR-L0 范围**：docs-only；local commits allowed；push forbidden。
> **PR-L0 后 source-of-truth**：`docs/ai/CODEX_MISSION_learning_loop.md`
> **核验纪律**：永不只看汇总指标下结论；必须下钻原始 events、trace、run artifacts 和 hard-gate fields 验证样本有效性。

---

## 1. 研究问题与对外结论目标

**问题**：知识飞轮（注入 + 结局归因 + Thompson 排序 + epsilon 探索）是否使 Alaya 的决策质量产生可发布的显著提升？

**唯一主变量**：`ALAYA_KNOWLEDGE_INJECTION`。

- baseline arm：`ALAYA_KNOWLEDGE_INJECTION=off`
- treatment arm：`ALAYA_KNOWLEDGE_INJECTION=on(full)`，即知识注入开启、Thompson 排序开启、epsilon 探索开启、结局归因开启

**主指标**：配对 case 决策准确率 `decisionAccuracy`，按 `groundTruthDecision` 判定。

**次指标**：ECE（沿用既有 confidence calibration 口径但输入列更新为 learning-loop case）、`heldOutAccuracy`、`learningCurve` 趋势、Brier 分数、`cumulativeRegret`、`knowledgeROI`、`forgettingRate`。

次指标不参与 H1 主判定，主失败不可被次指标抵消。PR-L0 只冻结设计；不产生任何学习效果、科学结论或产品结论。

## 2. 假设（事前冻结，事后不得修改）

配对设计：第 i 个 replicate 中，两臂共享同一 `worldSeed` 与 case 序号集，定义：

`d_i = decisionAccuracy_treatment_i - decisionAccuracy_baseline_i`

正值表示知识飞轮更好。

**H1 主判据 — 优越性（单侧配对 t）**

- H0: `mu_d <= 0`
- H1: `mu_d > 0`
- alpha = 0.05（单侧）
- PASS：p < 0.05 且 `mean(d_i) > 0`

**H1 回退判据 — 等效性（TOST），仅当主判据不显著时启用**

- 等效边界 Delta = 0.05 absolute accuracy（5 percentage points）
- H0_lower: `mu_d <= -0.05`
- H0_upper: `mu_d >= +0.05`
- 两个单侧检验均在 alpha = 0.05 拒绝时，判「知识飞轮在 +/-0.05 accuracy 边界内无实践收益」

**H1 三种可发布结局（穷尽）**

1. 主判据显著且方向为正：可发布「知识飞轮显著提升决策质量」。
2. 主判据不显著但 TOST 成立：可发布「在 +/-0.05 accuracy 边界内等效，当前飞轮形态无实践收益」。
3. 主判据不显著且 TOST 不成立：发布 `inconclusive`，报告观测效应、CI、所需 N 或诊断方向。绝不包装成任一方向强结论。

**H2 — 学习曲线（treatment arm 内部）**

- 主序列：按 cycle 分块的决策准确率序列。
- block size：10 resolved/scored cases per block，冻结为 10。
- 检验：Mann-Kendall 趋势检验，alpha = 0.05，方向为正。
- PASS：趋势方向为正且 p < 0.05。
- 副序列：按同一 block size 计算 Brier 分数，方向为下降，仅描述性报告，不参与 H2 判定。
- 可发布结局二元：`PASS` 或 `not-supported`。LOW_COVERAGE、趋势不显著、方向错误均归入 `not-supported`，并必须说明原因。

**H3 — 泛化（held-out pool）**

- held-out pool 不参与 Distiller 蒸馏、结局归因训练或 world-rule 经验积累。
- 在 held-out pool 上单独重复 H1 主判据。
- held-out scored < 20/arm/run 或 held-out pool 污染时，归入 `not-supported`，并标注 `LOW_COVERAGE` 或 `HELDOUT_LEAKAGE`，不给方向性结论。
- 可发布结局二元：`PASS` 或 `not-supported`。

## 3. 样本量、world seeds 与功效（事前 power analysis）

**case 产能与分池**

- 每个 arm 每个 replicate 目标生成并 resolve >= 120 cases。
- train/held-out split：80/20。
- 每个 arm 每个 replicate 的目标 case 数：train >= 96，held-out >= 24。
- 每 run 有效性硬门：train scored >= 60/arm，held-out scored >= 20/arm，scoreableCoverage >= 0.6。

**world-seed 集合（事前冻结）**

最多 24 paired replicates，按下列 seed 顺序执行；不得在看到结果后替换、重排或跳过已通过 hard gates 的 replicate：

`2026070901, 2026070902, 2026070903, 2026070904, 2026070905, 2026070906, 2026070907, 2026070908, 2026070909, 2026070910, 2026070911, 2026070912, 2026070913, 2026070914, 2026070915, 2026070916, 2026070917, 2026070918, 2026070919, 2026070920, 2026070921, 2026070922, 2026070923, 2026070924`

**Pilot 与最终 N 决策**

- Stage A pilot：前 4 paired replicates（8 arm-runs），全部通过 hard gates 时计入最终样本。
- Pilot 只估计 `sigma_d`，不得改变 alpha、Delta、指标、block size、hard gates、world seeds 或变量定义。
- Stage B 前根据下表自动冻结最终 paired N，并把 N 决策 commit 入 run planning artifact；不得人工自由裁量。

| pilot sigma_d | final paired N | interpretation |
| --- | ---: | --- |
| `sigma_d <= 0.05` | 8 | superiority test expected to be reasonably powered for 5pp effects |
| `0.05 < sigma_d <= 0.08` | 12 | moderate variance; continue with larger N |
| `0.08 < sigma_d <= 0.10` | 16 | high variance; superiority harder, TOST/inconclusive likely |
| `0.10 < sigma_d <= 0.15` | 24 | maximum planned N |
| `sigma_d > 0.15` | 24 | maximum planned N; superiority likely underpowered, still report TOST/inconclusive by rule |

**Power tooling**

- Use `analysis/phase3_pilot_decision.py` as the implementation base for sigma/N decision logic, extended only as needed for learning-loop input columns.
- Use `analysis/phase3_stats.py` for paired t and TOST decision logic; logic may not be changed after PR-L6 freeze, only input columns may differ.
- N selected by the table above is frozen before Stage B's first non-pilot replicate.

## 4. 变量锁定（单变量原则）

唯一允许变化的变量：

| field | baseline arm | treatment arm |
| --- | --- | --- |
| `ALAYA_KNOWLEDGE_INJECTION` | `off` | `on(full)` |

其余全部锁死：

| 项 | 锁定值 |
| --- | --- |
| PR-L0 content freeze | `content_freeze_commit` header value after anchor-record commit |
| code/metric anchor | `TBD_AFTER_PR_L6_MAIN_MERGE` |
| scenario generator | `scripts/lib/learning-scenario-generator.mjs` as merged by PR-L1 |
| domain config | scenario-domain config as merged by PR-L1; logic/domain separation required |
| world seeds | §3 listed seeds, in order |
| train/held-out split | 80/20 |
| cases per arm/replicate | target >=120 generated/resolved, hard gate train scored >=60 and held-out scored >=20 |
| Provider | OpenAI-compatible MiniMax-M3 or configured equivalent through `LLMProvider`; same endpoint/model for both arms |
| thinking | `MINIMAX_THINKING=disabled` in both arms |
| Scheduler/run mode | PR-L6 harness-locked; same scheduler settings across arms |
| ranking/exploration in treatment | Thompson sampling + epsilon = 0.1 |
| ranking/exploration in baseline | injection disabled; no prior-knowledge prompt content |
| pairing | same `worldSeed`, case ids, case order, and ground truth per pair; separate DB/port/log-dir per arm |
| metric code | `health-signal-quality.mjs`, `shadow-analyze.mjs`, `analysis/extract_phase3_metrics.py`, `analysis/phase3_stats.py` at PR-L6 code anchor |
| block size | 10 scored cases per block |
| alpha | 0.05 |
| H1 Delta | 0.05 absolute accuracy |

Credentials and usage metadata are not experimental variables. Missing credentials stop as `BLOCKED_CREDENTIALS`; missing auditable usage metadata stops as `BLOCKED_USAGE_METADATA`.

## 5. 有效性硬门（每 run 必须全过，否则作废重跑，不计入）

1. assessment 来自自然 `summary.json`，非中途快照、非 reconstruction。
2. train scored >= 60/arm；held-out scored >= 20/arm；scoreableCoverage >= 0.6。
3. correctnessMode 全为 truth，即按 `groundTruthDecision` / `calibrationTruth` 判定，非 oracle 回退。
4. providerRatio = 1.0；`tokenSourceProvider >= 0.95`。
5. 错误门全 0：schema_error、parse_error、provider_contract_error、trace_schema_error、analyzer_schema_error 均为 0。
6. 下钻抽查：随机抽 >=10 cases，人工核对 prompt、groundTruthDecision、model decision、判分一致。
7. held-out isolation：held-out case 无一进入 Distiller、knowledge credit、ROI training input 或任何训练/经验回写路径；必须有 trace 证据。
8. watchdog 全绿，finalDrain complete。
9. governance redline 抽查：credit/thompson/epsilon 写路径全部有审计 event；无绕过 human strong gate 的状态跃迁；污染状态知识不进入高风险证据集。
10. 单个连续 24h 证据目录，>=48 metrics snapshots；中断则该 replicate 作废重跑。
11. Usage metadata captured：至少包含 arm、replicate id、provider/model route、token source、token counts or auditable provider usage fields、estimated/actual cost fields when available；缺失则 `BLOCKED_USAGE_METADATA`。
12. Credentials available and valid before real provider execution；缺失或不可读则 `BLOCKED_CREDENTIALS`。

作废 run 必须留档说明触发的 hard gate 条目，但 raw provider artifacts、DB、run dirs 不进 git。

## 6. 等效边界 Delta=0.05 的事前理由

Delta = 0.05 absolute accuracy（5 percentage points）在看到任何 learning-loop repeat run 数据之前冻结。

理由：

- 本实验的目标不是证明极小统计差异，而是判断知识飞轮是否带来对下游决策可操作的收益。
- 低于 5pp 的 paired decisionAccuracy 差异，在每 arm 每 replicate 约 120 cases、held-out 约 24 cases 的设计下，容易被场景采样、provider 抖动、少量边界 case 翻转吞没。
- 5pp 以内即便统计上可分辨，也不足以单独支持更复杂的 credit/ranking/exploration 机制成为产品或科学主张。
- Delta 不来自任何 learning-loop 观测效应；PR-L0 时尚未运行 PR-L1+ generator、PR-L6 harness 或 RUN-L7。

若 reviewer 要求敏感性展示，可附 Delta=0.03 的 TOST 结果作为稳健性分析，但不得替换主判据。

## 7. 统计分析计划（锁定）

**H1 主分析**

- 对 paired replicate 的 `d_i` 做单侧配对 t（等价于 one-sample t on `d_i`）。
- 报告 `mean(d_i)`、standard deviation、t、df、one-sided p、two-sided 95% CI。
- PASS 只在 p < 0.05 且方向为正时成立。

**H1 回退 TOST**

- 仅当 H1 主判据不显著时执行。
- Delta = +/-0.05。
- 报告两个单侧检验和 90% CI 是否完全落入等效边界。

**正态性与稳健性**

- 对 `d_i` 做 Shapiro-Wilk。
- 若小样本偏态或明显离群，附 Wilcoxon signed-rank 作为稳健性展示；Wilcoxon 不替换主判据。

**H2**

- Treatment arm 内部按 block size 10 生成 block-level accuracy 序列。
- Mann-Kendall 趋势检验，方向为正，alpha=0.05。
- Brier 分数序列方向为降，仅描述性报告。

**H3**

- 在 held-out pool 上计算 paired held-out accuracy difference，并重复 H1 主分析。
- held-out LOW_COVERAGE 或 leakage 直接归入 `not-supported`。

**多重比较**

- H1 是唯一主结论。
- H2/H3 是预注册的次要命题，按各自规则独立报告。
- 不得用 H2/H3 阳性弥补 H1 失败。

**原始证据下钻**

- 每个新指标必须可下钻到 `events.jsonl`、trace rows、case id、pool、ground truth、decision、confidence、arm、replicate。
- 样本不足时输出 `LOW_COVERAGE`，不得输出好看的点估计。

## 8. 不允许的事后操作（明令禁止）

- 修改 Delta、alpha、final N table、block size、train/held-out split、world seeds、hard gates 或 PASS 判据以迁就已见数据。
- 以任何理由剔除已通过 hard gates 的 run；作废 run 只能由 §5 hard gate 失败触发并留档。
- 用 train pool 结果冒充 held-out 结论。
- 修改 world rules、scenario generator 参数或 domain config 后继续沿用旧预注册。
- 修改 metrics/analyzer/scorer 以让已见结果变好。
- 用 reconstruction 或中途 snapshot 作为 PASS 依据。
- 把 `inconclusive` 包装成方向性结论。
- 把 30min mock smoke、3h compressed precheck、CI green、provider health 或 local tests 报告成 RUN-L7 formal acceptance。
- 在 H1 未 PASS 且人类未明确批准时启动 PR-L8 或任何权重级学习。
- 把 README、whitepaper、landing/public wording 写成 science/product claim，除非 RUN-L7 formal result 支持且人类批准 wording。

## 9. PR-L0 / PR-L1+ 证据边界

PR-L0 evidence layer is `local checks` only:

- 本文件冻结研究设计。
- `docs/ai/CODEX_MISSION_learning_loop.md` 成为 PR-L0 后 mission source-of-truth。
- `npm run guard`、`npm run secret:scan` 只能证明本地静态检查，没有学习效果含义。

Later evidence layers:

- PR-L1 through PR-L6 local tests are `local checks`。
- 30min mock smoke and 3h compressed precheck are `smoke evidence`。
- RUN-L7 24h paired run with natural `summary.json` and all hard gates is `long-run/formal acceptance`。
- README/whitepaper/public wording is `science/public claim` and requires RUN-L7-supported wording plus human approval.

## 10. Stop Conditions And Status Labels

- `HARD_BLOCK`：requested change violates `PRINCIPLES.md`, repo/root mismatch, or PR-L0 scope attempts to touch forbidden paths.
- `BLOCKED_CREDENTIALS`：real provider/model execution needs credentials and they are missing, unreadable, invalid, or ambiguous.
- `BLOCKED_USAGE_METADATA`：usage metadata cannot be captured/audited for real provider/model execution.
- `VALIDATION_BLOCKED`：required local validation command cannot run for environment/tooling reasons.
- `NEEDS_REPAIR`：validation/review finds fixable implementation or doc defects.

`BLOCKED_COST_CAP` is not used for this mission: user approved no cost/token/call cap for mission-scoped Codex CLI gpt-5.5 and required model/provider execution. Cost approval does not waive credentials, usage metadata, RUN-L7 start approval, merge approval, tag approval, public/science wording approval, or PR-L8 approval.

## 11. Source-Of-Truth And Anchor Discipline

- Before PR-L0 lands, source mission is `/Users/peachy/Downloads/CODEX_MISSION_learning_loop (1).md`.
- After PR-L0 lands, source mission is `docs/ai/CODEX_MISSION_learning_loop.md`.
- PR-L0 uses two local commits and no push:
  1. content-freeze commit: substantive prereg + mission archive only.
  2. anchor-record commit: update only `PR-L0 content_freeze_commit` in this file.
- The anchor-record commit must not change hypotheses, thresholds, variables, sample size, metrics, hard gates, source mission content, or substantive prereg sections.
- PR-L6/RUN-L7 code/metric anchor remains TBD until PR-L6 merges to `main`.
