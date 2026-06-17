# Alaya 认知质量 · 发布级强结论实验 · 预注册

> **预注册时间戳**：填写实际冻结时间（建议跑首个 pilot 前冻结本文件并 commit，取 commit hash 为不可篡改证据）
> **分支**：`codex/shadow-run-24h`（或新建 `codex/phase3-publication`）
> **冻结代码锚点**：commit `c0319d15`（calibration ground-truth 修复后；ECE 度量定义以此为准，实验期间不得修改）
> **核验纪律**：永不只看汇总指标下结论；必须下钻 reliabilityTable / 原始 events 验证样本有效性。预注册补充第 4 条规则继续生效（注入样本系统性 accuracy≈0 → 判度量无效需重跑）。

---

## 1. 研究问题与对外结论目标

**问题**：在 Alaya 投研主题版的认知质量度量（confidence calibration，主指标 ECE）上，`MINIMAX_THINKING=adaptive` 相比 `MINIMAX_THINKING=disabled` 是否存在可发布的显著差异？

**目标对外结论方向**：**优越性 — disabled 在 ECE 上显著优于 adaptive**（用户预设方向）。

**已知单次证据**（来自 Phase2，不可作为发布依据，仅供设计）：
- ECE_disabled = 0.2012，ECE_adaptive = 0.2067，观测差 = +0.0055（disabled 更低/更好）
- faithfulness 0.9388 vs 0.9410（次指标，主失败不可抵消）
- 该差异在单次数据中属噪声级，无 p 值 → 这正是本实验要解决的问题。

---

## 2. 假设（事前冻结，事后不得修改）

配对设计：第 i 个 replicate 中，disabled 臂与 adaptive 臂共享同一注入 scenario 种子/序号，定义
`d_i = ECE_adaptive_i − ECE_disabled_i`（正值表示 disabled 更好）。

**主判据 — 优越性（单侧配对 t 检验）**
- H0: μ_d ≤ 0（disabled 不优于 adaptive）
- H1: μ_d > 0（disabled 优于 adaptive）
- α = 0.05（单侧）
- 判 PASS：p < 0.05 且效应方向为正（disabled 更低）。

**回退判据 — 等效性（TOST），仅当主判据不显著时启用**
- 等效边界 Δ = **0.02**（事前定义：ECE 差异 < 0.02 视为实践上无意义；理由见 §6）
- H0_lower: μ_d ≤ −Δ；H0_upper: μ_d ≥ +Δ
- 两个单侧检验均在 α=0.05 拒绝 → 判定**等效**（adaptive 不带来认知质量收益，默认 disabled 合理）。

**预注册的三种可发布结局（穷尽）**
1. 主判据显著 → 发布「disabled 显著优于 adaptive」。
2. 主判据不显著但 TOST 等效成立 → 发布「二者在 ±0.02 边界内等效，故默认 disabled 合理」。
3. 主判据不显著且 TOST 不成立（CI 跨越边界）→ 发布「现有样本量不足以分辨；报告 inconclusive + 所需 N」。**绝不把结局 3 包装成任一方向的强结论。**

---

## 3. 样本量与功效（事前 power analysis）

效应 δ = 0.0055，单侧 α=0.05，目标功效 0.80，配对 t 检验。所需 N 强依赖 run 间配对差异标准差 σ_d：

| σ_d | n=8 功效 | 达 80% 所需 n | n=8 的 MDE |
|---|---|---|---|
| 0.004 | 0.97 | 5 | 0.0039 |
| 0.006 | 0.75 | 9 | 0.0059 |
| 0.008 | 0.54 | 15 | 0.0078 |
| 0.010 | 0.41 | 22 | 0.0098 |
| 0.015 | 0.24 | 48 | 0.0147 |

**分水岭**：仅当 σ_d ≤ ~0.005 时，n=8/臂 才有 ≥80% 功效检出 δ=0.0055。

**两阶段执行（事前约定）**
- **阶段 A（pilot，2 对 = 4 run）**：估计 σ_d。
  - σ_d ≤ 0.005 → 维持 n=8/臂，进阶段 B 走优越性。
  - 0.005 < σ_d ≤ 0.008 → 将 n 提升到 §3 表对应值（≤15/臂）。
  - σ_d > 0.010 → 优越性事实上不可达；阶段 B 仍跑满计划样本，但主结论按 TOST 等效或 inconclusive 走。
- pilot 的 4 个 run **计入**最终样本（设计不变，仅用于 N 决策，不改判据）。
- N 的最终值在 pilot 后、阶段 B 首个新 run 前冻结并 commit。

---

## 4. 变量锁定（单变量原则）

唯一允许变化的变量：`MINIMAX_THINKING` ∈ {disabled, adaptive}。其余全部锁死：

| 项 | 锁定值 |
|---|---|
| 代码 | commit `c0319d15`（含 calibration 修复）|
| scenario | cognition-coverage（`scripts/lib/cognition-coverage-scenario.mjs`，含显式 calibrationTruth）|
| Provider | `ALAYA_LLM_PROVIDER=openai` / `OPENAI_BASE_URL=https://api.minimax.io/openai` / `OPENAI_MODEL=MiniMax-M3` |
| Scheduler | `ALAYA_SCHEDULER=false` / `ALAYA_AUTO_SEED_DEMO=false` |
| 注入序号 | 每个 replicate 的两臂用**相同**序号集（配对前提）|
| ECE 度量 | `evaluateConfidenceCalibration`，bucketCount=10，公式不变 |
| 覆盖门槛 | scored/eligible ≥ 30，scoreableCoverage ≥ 0.6 |

两臂用不同 DB / 端口 / log-dir。

---

## 5. 有效性硬门（每个 run 必须全过，否则该 run 作废重跑，不计入）

1. assessment 来自自然 summary.json（非中途快照）
2. calibration scored/eligible ≥ 30 且 scoreableCoverage ≥ 0.6
3. correctnessMode 全为 truth（calibration_truth_decision），非 oracle 回退
4. providerRatio = 1.0（tokenSourceProvider ≥ 95%）
5. 错误门全 0（schema_error 等）
6. **reliabilityTable 下钻：注入样本所在桶（预期 bucket 8, conf 0.81-0.86）accuracy 不得系统性 ≈0**（预注册补充第 4 条）；若 ≈0 → 度量无效，查 scenario，不依字面 ECE 下结论
7. watchdog 全绿 + finalDrain complete

---

## 6. 等效边界 Δ=0.02 的事前理由（防事后辩护质疑）

- ECE 的实践解读：0.02 的 ECE 差异意味着平均每个置信桶的「置信度−准确率」偏差相差 2 个百分点，低于单桶 1-2 个样本翻转引起的抖动量级，对下游投研决策不构成可操作差异。
- 该边界在**看到任何重复 run 数据之前**定义，且不等于观测效应（0.0055），避免循环论证。
- 若 reviewer 质疑边界过宽，敏感性分析附 Δ=0.01 的 TOST 结果（仅作稳健性展示，不改主判据）。

---

## 7. 统计分析计划（锁定）

- 主分析：单侧配对 t 检验（scipy.stats.ttest_rel 单侧化，或一样本 t on d_i）。报告 t、df、单侧 p、μ_d 点估计、95% CI（双侧）。
- 配对前提校验：Shapiro-Wilk 检验 d_i 正态性；若 n 小且偏态，附 Wilcoxon signed-rank 作为稳健性（预注册为次要，不替换主判据）。
- 回退：TOST（两个单侧 t 检验，Δ=±0.02），报告 90% CI 是否落入边界。
- 次指标 faithfulness：仅描述性报告，**不参与**主结论（主指标失败不可被次指标抵消，沿用 Phase2 纪律）。
- 多重比较：主结论只有一个主指标，无需校正；faithfulness 为探索性。
- 所有分析脚本在 pilot 前写好并冻结（见 `analysis/phase3_stats.py`），跑数据时不改代码。

---

## 8. 不允许的事后操作（明令禁止）

- 不得在看到结果后调整 Δ、α、判据方向或样本量上限。
- 不得剔除「不利」run（仅 §5 硬门失败的 run 可作废，且作废理由须记录）。
- 不得切换主/次指标角色。
- 不得用 faithfulness 抵消 ECE 结论。
- 不得把结局 3（inconclusive）措辞成任一方向的强结论。
