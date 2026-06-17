# 自适应思考（Adaptive Thinking）是否提升 LLM 投研智能体的认知质量？
## 一项预注册、配对、多次重复的对照实验

> **状态**：骨架（待数据回填）。带 `〔TODO〕` 的位置在 16-run 完成后由 `phase3_stats.py` 输出回填。
> **配套**：预注册 `EXPERIMENT_PREREG_phase3_publication.md`、执行手册 `RUN_PLAYBOOK_phase3.md`、分析脚本 `phase3_stats.py`。

---

## 摘要（Abstract）

我们评估了在 Alaya 投研主题智能体中，将底层 LLM（MiniMax-M3）的 `MINIMAX_THINKING` 由 `disabled` 切换为 `adaptive` 是否改善置信度校准质量（主指标：期望校准误差 ECE，越低越好）。采用预注册、按种子配对、8 对重复（含 2 对 pilot 定样本量）的双臂设计，唯一变量为 thinking 模式。〔TODO 主结论一句话：disabled 显著更优 / 二者等效 / inconclusive〕。〔TODO 关键数字：mean Δ、p 值、CI〕。次指标 faithfulness 仅作描述性报告，不参与主结论。

---

## 1. 背景与动机

- Alaya 投研主题版以 confidence calibration 作为认知质量主指标；前期 24h 影子验收确立了 `MINIMAX_THINKING=disabled` 的可冻结基线。
- 单次 Phase2 实验观测到 ECE_disabled=0.2012 vs ECE_adaptive=0.2067（差 0.0055），但属噪声级、无统计效力，仅为 null result。
- 本研究将其升级为**可对外发布的强结论**：通过多次重复 + 预注册检验，给出有 p 值、抗下钻审查的判定。

---

## 2. 方法

### 2.1 度量定义（冻结于 commit `c0319d15`）
- ECE：10 桶 binned，`Σ (n_bucket/N)·|accuracy − confMean|`（`scripts/lib/health-signal-quality.mjs:704`）。
- Calibration ground-truth：注入样本携带显式 `calibrationTruth`（mode=decision_matches_expected, expectedDecision=tiered_thesis），同侧 dedupe/supersede 不计为错（`scripts/lib/cognition-coverage-scenario.mjs`、`health-signal-quality.mjs:459-520`）。此修复消除了 Phase2 第一轮的 bucket-7 全错 artifact。

### 2.2 实验设计
- 双臂：disabled vs adaptive，唯一变量 `MINIMAX_THINKING`，其余 env/代码/scenario 全锁定（见预注册 §4）。
- **配对**：每个 replicate 两臂共享注入序号集；分析基于 `d_i = ECE_adaptive_i − ECE_disabled_i`。
- 重复：8 对（含先行 2 对 pilot）；交错随机执行顺序消除时间漂移偏倚。
- scenario：cognition-coverage（6 固定 case，confidence 0.81–0.86，集中落入 bucket 8）。

### 2.3 有效性硬门（每 run）
scored≥30、coverage≥0.6、correctnessMode 全 truth、providerRatio=1.0、错误门全 0、bucket-8 accuracy 非系统性≈0、watchdog 绿 + finalDrain complete。失败 run 作废重跑。

### 2.4 统计分析（预注册，冻结）
- 主判据：单侧配对 t 检验，H1: μ_d>0（disabled 优）。α=0.05。
- 回退：TOST 等效，Δ=±0.02（敏感性 Δ=±0.01）。
- 稳健性：Shapiro 正态性 + Wilcoxon signed-rank。
- 功效：见 §3 pilot；δ=0.0055 在 σ_d≤0.005 时 n=8 达 ~80% 功效。

---

## 3. Pilot 与样本量决策

〔TODO 回填〕估计 σ_d = ___，n=8 功效 = ___，最终 N = ___/臂。决策记录：`validation-logs/phase3_N_decision.md`。

---

## 4. 结果

### 4.1 主指标 ECE
〔TODO 回填表：每对 disabled/adaptive 的 ECE、d_i〕

| pair | ECE disabled | ECE adaptive | d_i |
|---|---|---|---|
| 〔TODO〕 | | | |

- mean d = 〔TODO〕，sd = 〔TODO〕
- 配对 t：t(df)=〔TODO〕，单侧 p=〔TODO〕，95% CI=〔TODO〕
- 正态性 Shapiro p=〔TODO〕；Wilcoxon p=〔TODO〕

### 4.2 预注册判定
〔TODO 从 phase3_stats.py 的 "PRE-REGISTERED VERDICT" 回填一种〕

### 4.3 次指标（描述性，不参与结论）
faithfulness disabled=〔TODO〕 / adaptive=〔TODO〕。

---

## 5. 下钻验证（核验纪律）

> 强结论必须抗下钻。本节证明结论非汇总 artifact。

- **bucket 分布**：注入样本应集中于 bucket 8（conf 0.81–0.86）。〔TODO 列每臂 bucket-8 n/accuracy/confMean〕，确认无系统性 accuracy≈0。
- **correctnessMode**：〔TODO 确认全为 calibration_truth_decision，无 oracle 回退〕。
- **provider**：〔TODO 确认所有 run providerRatio=1.0，无 schema 降级〕。
- **作废 run**：〔TODO 列出作废 run 及理由，证明未剔除不利有效数据〕。

---

## 6. 讨论与局限

- **外部效度**：cognition-coverage 是人造高密度 scenario，结论不直接外推到真实投研负载（沿用 Phase2 范围说明）。
- **校准绝对水平**：无论臂别，真实 ECE≈0.20 远高于良好校准 (<0.1)；这是独立于 thinking 的产品改进课题，本研究不解决。
- **等效边界选择**：Δ=0.02 的合理性见预注册 §6；附 Δ=0.01 敏感性。
- **单模型/单 provider**：仅 MiniMax-M3，不外推其他模型。

---

## 7. 结论

〔TODO〕。产品含义：〔TODO 是否支持默认 disabled〕。

---

## 附录 A · 可复现性
- 代码锚点 commit `c0319d15`，分支 `codex/shadow-run-24h`。
- 预注册时间戳与 commit：〔TODO〕。
- 执行顺序种子：random.seed(20260617)，`docs/validation/phase3_run_order.txt`。
- 原始指标：`analysis/phase3_results.csv`；分析脚本 `phase3_stats.py`。
