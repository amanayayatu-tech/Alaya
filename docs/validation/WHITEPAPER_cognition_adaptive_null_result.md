# Adaptive Thinking 是否提升 Alaya 认知质量？

## 摘要

本报告评估在 Alaya 投研主题智能体中，将 MiniMax-M3 的 `MINIMAX_THINKING` 从 `disabled` 切换为 `adaptive` 是否能提升认知质量。现有真实证据只来自 Phase2 的一次双臂对照：ECE_disabled = 0.2012，ECE_adaptive = 0.2067，观测差 Δ = +0.0055，方向上是 disabled 更低、更好。但这是单次观测，没有重复样本、没有方差估计、没有 p 值，不能支持“adaptive 更差”或“disabled 显著更优”的强结论。正确结论是诚实的 null result：当前无证据支持开启 adaptive 来提升认知质量；在缺乏发布级重复证据前，默认 `disabled` 是更合理、更简单的产品选择。为避免把噪声包装成发现，本报告给出 power analysis，并引用已预注册的 Phase3 配对重复实验设计作为后续可发布结论的路径。

## 背景

Alaya 的认知质量主指标是 confidence calibration，用 ECE 衡量模型声明置信度与实际正确性的偏差。Phase2 的目标不是证明 thinking 模式优劣，而是验证 calibration 度量能否在 cognition-coverage 场景中诚实工作。早期一次结果出现过 bucket-7 注入样本被系统性误判全错的 artifact，使 ECE 虚高到 0.7。这个教训很关键：汇总 ECE 本身不是证据，只有在 correctness truth、bucket 分布和 reliabilityTable 下钻都成立时，ECE 才能进入结论。

度量修复冻结于 commit `c0319d15`。修复点包括：`scripts/lib/cognition-coverage-scenario.mjs` 为注入样本写入显式 `calibrationTruth`；`scripts/lib/health-signal-quality.mjs` 改用事件 truth 判定，并且同侧 dedupe/supersede 不计为错。ECE 定义保持为 10 桶 binned 形式：`Σ (n_bucket/N)·|accuracy−confMean|`。因此，下文 Phase2 双臂结果可以作为可信的单次观测，但不能被升级为发布级因果结论。

## 观测数据

Phase2 度量修复后的双臂单次结果如下。RUN 目录为 `validation-logs/phase2_cog_truth_20260617_134200_base` 与 `validation-logs/phase2_cog_truth_20260617_134200_treat`；对应预注册为 `validation-logs/EXPERIMENT_PREREG_phase2_20260617_125727.md`。

| arm | ECE | faithfulness | calibration scored/eligible | correctnessMode | providerRatio |
|---|---:|---:|---:|---|---:|
| disabled | 0.2012 | 0.9388 | 39/39 | all `calibration_truth_decision` | 1.0 |
| adaptive | 0.2067 | 0.9410 | 40/40 | all `calibration_truth_decision` | 1.0 |

主指标 ECE 的观测差为 `ECE_adaptive − ECE_disabled = +0.0055`，即 disabled 在这一次 run 中更低。faithfulness 方向很小且属于次指标；它不能抵消或替代 ECE 的主结论。更重要的是，这张表只有一次 paired observation，没有重复 run，因此没有 run 间方差，也不能给出 p 值、置信区间或等效性结论。它只能支持一句话：在这次可信单次观测中，没有证据显示 adaptive thinking 改善了主指标 ECE。

## 为何单次 delta 不可信

0.0055 看似有方向，但对 ECE 来说处于噪声量级。cognition-coverage 是高密度人工场景，样本集中在 0.81-0.86 置信区间附近；单桶中 1-2 个样本翻转即可造成 ECE 约 ±0.02-0.05 的抖动。因此，单次 Δ=0.0055 不能被当成稳定效应。

预先计算的 power analysis 说明了问题。目标效应 δ=0.0055，单侧 α=0.05，目标功效 0.80，使用配对 t 检验；所需样本量取决于 run 间配对差异标准差 σ_d。

| σ_d | n=8/臂 功效 | 达 80% 所需 n/臂 | n=8 的最小可检效应 MDE |
|---|---:|---:|---:|
| 0.004 | 0.97 | 5 | 0.0039 |
| 0.006 | 0.75 | 9 | 0.0059 |
| 0.008 | 0.54 | 15 | 0.0078 |
| 0.010 | 0.41 | 22 | 0.0098 |
| 0.015 | 0.24 | 48 | 0.0147 |

核心分水岭是：只有当 σ_d ≤ ~0.005 时，n=8/臂 才有 ≥80% 功效检出 δ=0.0055；当 σ_d ≥ 0.010 时，需要 ≥22/臂，优越性检验事实上不可达。Phase2 单次结果没有 σ_d，因此不能判断当前观测差是否可重复。把 0.0055 写成“发现 adaptive 劣化”或“disabled 显著更优”，都会越过证据边界。

## 发布级实验设计

发布级实验已经在 `docs/validation/EXPERIMENT_PREREG_phase3_publication.md` 中预注册，冻结点为 commit `00a60d75`。设计采用配对重复：同一 pair 内两臂共享 seed 与注入序号，唯一变量是 `MINIMAX_THINKING`，并定义 `d_i = ECE_adaptive_i − ECE_disabled_i`。正值表示 disabled 更好。

主判据是单侧配对 t 检验，方向为 disabled 在 ECE 上优于 adaptive；只有 p < 0.05 且方向为正，才能发布优越性结论。若主判据不显著，才进入 TOST 等效检验，主等效边界为 Δ=±0.02，敏感性边界为 ±0.01。重要的是：TOST 只是预注册的回退分析，Phase2 单次结果尚不能证明等效。

每个 run 必须通过 7 道硬门：scored≥30、coverage≥0.6、correctnessMode 全 truth、providerRatio=1.0、错误门全 0、bucket-8 accuracy 不得系统性≈0、watchdog 绿且 finalDrain complete。执行手册为 `docs/validation/RUN_PLAYBOOK_phase3.md`，分析脚本为 `analysis/phase3_stats.py`、`analysis/phase3_pilot_decision.py` 和 `analysis/extract_phase3_metrics.py`。Phase3 采用两阶段流程：先跑 pilot 估计 σ_d，再决定最终 N；只有在 σ_d 足够小的情况下，才有资格追求“disabled 显著优越”的发布结论。

## 下钻验证纪律

本实验族最大的风险不是统计公式错误，而是把 artifact 当成认知质量差异。Phase2 第一轮已经证明，单看汇总 ECE 会误导：bucket-level truth 归因错误会制造虚假的高 ECE。后续任何结论都必须同时检查 reliabilityTable、correctnessMode、providerRatio、错误门和原始事件链。

预注册补充第 4 条尤其重要：如果注入样本所在桶出现系统性 accuracy≈0，就不能按字面 ECE 下结论，而应判定度量无效并检查 scenario 或 truth 路径。换言之，硬门不是形式审查，而是结论合法性的组成部分。

## 结论

当前结论是诚实 null result：Phase2 单次可信观测没有提供 adaptive thinking 改善认知质量的证据。产品上，默认 `MINIMAX_THINKING=disabled` 合理，因为它没有在主指标上表现更差的发布级证据负担，同时避免了 adaptive 带来的 schema 复杂度；历史上 adaptive schema 修复曾将 providerRatio 从 0.58 拉回到 1.0，这说明它确实增加了工程约束。

但这不等于 adaptive 更差，也不等于已经证明两臂等效。若要发布“disabled 显著优越”或“二者等效”，必须按 Phase3 预注册设计跑满配对重复，并让统计结论由真实 σ_d、有效 run 和预注册判据共同决定。

## 局限

第一，本报告只覆盖 MiniMax-M3，不外推到其他模型或 provider。第二，cognition-coverage 是人造高密度 scenario，6 个固定 case、confidence 0.81-0.86、集中落在 bucket 8；它适合度量校准能力，不代表真实投研全场景。第三，ECE≈0.20 远高于良好校准 <0.1，这说明校准绝对水平本身仍是独立产品改进课题，不能通过 thinking 开关讨论替代。第四，Phase2 只有单次观测，没有 run 间方差估计，因此不能直接给出显著性、置信区间或等效结论。

## 附录·可复现性

- Phase2 预注册：`validation-logs/EXPERIMENT_PREREG_phase2_20260617_125727.md`
- Phase2 RUN：`validation-logs/phase2_cog_truth_20260617_134200_base`，`validation-logs/phase2_cog_truth_20260617_134200_treat`
- 度量修复冻结：commit `c0319d15`
- Phase3 预注册冻结：commit `00a60d75`
- Phase3 预注册：`docs/validation/EXPERIMENT_PREREG_phase3_publication.md`
- Phase3 执行手册：`docs/validation/RUN_PLAYBOOK_phase3.md`
- Phase3 分析脚本：`analysis/phase3_stats.py`，`analysis/phase3_pilot_decision.py`，`analysis/extract_phase3_metrics.py`
- Power analysis 参数：δ=0.0055，单侧 α=0.05，目标功效 0.80，配对 t 检验；样本量随 σ_d 变化，见正文表。
