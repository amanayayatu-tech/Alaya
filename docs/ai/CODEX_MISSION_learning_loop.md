# CODEX MISSION — Alaya 认知增强闭环（Learning Loop）

> **执行人身份：** 你是一位资深全栈工程师 + AI 系统架构师，正在独立完成 Alaya 从「知识记账系统」到「可证伪的学习系统」的跨越。
> **核心原则：** 先读、再理解、再动手。绝不在没有文件依据的情况下推断。每个任务完成后运行对应测试。
> **不可逾越的边界：** 严格遵守 `PRINCIPLES.md` 的全部 6 条底线（纯函数核心、强知识人工闸门、审计写路径、污染知识过滤、灰区弱积累、LLMProvider 隔离）。违反任何一条立即停止并说明原因。
> **交付纪律：** 一个 PR 一个主题，一次冻结一个阶段。PR 之间严格按依赖顺序推进，不并行合并。产物（run 日志、报告、评审包）一律不进 git，作为外部证据归档。

---

## 0. 任务背景与总目标

当前 `main`（`7802ae20` 之后）的状态：24h 稳定基线已冻结（tag `baseline/shadow-24h-base-20260616`），adaptive-vs-disabled 得到诚实 null result。但该实验测的是**推理配置变量**（`MINIMAX_THINKING`），不是**学习变量**。

当前系统的学习环没有闭合，具体断点：

1. `alaya-app/server/knowledgeInjection.ts` 的检索是静态策略：FTS5/BM25 召回后按 `confidence_score DESC` 取 top-5，注入后只递增 `usageCount`。决策结局不回流到检索排序。
2. 知识的 `evidence_alpha / evidence_beta` 不因「这条知识参与的决策是对是错」而更新。
3. 所有质量指标（ECE、decisionTsr、faithfulness）都是单点快照，没有任何指标度量「第 N 轮是否优于第 1 轮」。
4. cognition-coverage 只有 6 个固定 case，无法区分学习与记忆，也凑不满 scored≥30 的功效门。

**总目标：** 闭合「注入 → 决策 → 结局 → 归因 → 排序更新」的奖励回路，建成可承载学习证明的场景环境，并用预注册双臂实验回答主命题：

> **H1（认知增强）**：知识注入开启臂的决策质量显著优于关闭臂（配对、同种子）。
> **H2（学习曲线）**：开启臂内部，按 cycle 分块的决策准确率随经验量显著上升。
> **H3（泛化）**：在从未参与知识蒸馏的 held-out case 上，H1 依然成立。

三个命题都可能失败。失败也是可发布结论（诚实 null result v2），**禁止**为凑阳性结果修改判据、场景或度量。

**RL 形式化映射（本任务包的机制语义，实现时对照自检）：**

| RL 要素 | Alaya 对应物 | 落地位置 |
| --- | --- | --- |
| State | 任务描述 + 项目上下文（FTS 查询输入） | `buildKnowledgeContext(taskDescription, ...)` |
| Action | 选择注入哪 5 条知识（含 ε-丢弃） | PR-L3 排序 + PR-L4 探索 |
| Reward | 该 cycle 预测 resolve 的对/错 | PR-L2 归因到 evidence α/β |
| Policy | Beta 后验采样排序（Thompson） | PR-L3，随 α/β 更新而演化 |
| 环境 | 可学世界规则的场景分布 | PR-L1 生成器 |
| 评估 | 学习曲线/regret/泛化 | PR-L5 指标 + RUN-L7 实验 |

这是**系统级 RL**（记忆 + 检索策略学习，不碰模型权重）。权重级学习是可选后续（见 §9 PR-L8），严禁提前开局。

---

## 1. 环境信息

```
仓库: https://github.com/amanayayatu-tech/Alaya
基线锚点: main @ 7802ae20（本任务包的冻结起点，所有 PR 从此出发）
技术栈: TypeScript / Express / SQLite (better-sqlite3) / FTS5 / React / npm workspaces
关键文件:
  alaya-app/server/knowledgeInjection.ts     — 知识注入（本任务包核心改造对象）
  alaya-app/server/storage.ts                — 数据层与审计写路径
  alaya-app/server/flywheel.ts               — 飞轮主逻辑（预测 resolve 的挂钩点）
  alaya-app/server/knowledgeReview.ts        — 知识晋级/降级/隔离
  alaya-app/server/trace.ts                  — trace 记录（injectedKnowledgeIds 已存在）
  scripts/lib/cognition-coverage-scenario.mjs — 现有场景（将被扩展为生成器）
  scripts/lib/health-signal-quality.mjs      — 质量指标计算
  scripts/shadow-analyze.mjs                 — run 分析器
  analysis/phase3_stats.py                   — 冻结的统计分析（配对 t + TOST）
  analysis/extract_phase3_metrics.py         — 指标抽取
  analysis/phase3_pilot_decision.py          — pilot 样本量决策
CI 约束: npm workspaces，只从仓库根目录安装依赖；子包 npm ci 会破坏根 node_modules。
```

---

## 2. 强制预读（执行任何任务之前必须完成）

按顺序完整读取，不跳过：

1. `PRINCIPLES.md` — 6 条底线
2. `alaya-app/server/knowledgeInjection.ts` — 当前注入逻辑全文
3. `alaya-app/server/storage.ts` — `updateKnowledge`、`recordEvent`、FTS 写路径
4. `alaya-app/server/flywheel.ts` — 预测创建与 resolve 的位置
5. `alaya-app/server/knowledgeReview.ts` + `knowledgeConflictHooks.ts` — 现有生命周期机制
6. `scripts/lib/cognition-coverage-scenario.mjs` — 现有 case 结构与 calibrationTruth 写法
7. `scripts/lib/health-signal-quality.mjs` — 指标口径
8. `docs/validation/EXPERIMENT_PREREG_phase3_publication.md` — 预注册格式与纪律
9. `docs/validation/WHITEPAPER_cognition_adaptive_null_result.md` — 已发布结论的边界

读取完毕后输出 **Pre-Read Summary**，必须包含：

- 预测（prediction）从创建到 resolve 的完整数据流（表名、字段、触发点）
- trace 中 `knowledge_injection` 事件记录了哪些字段
- `evidence_alpha / evidence_beta` 当前在哪些代码路径被修改
- 现有测试对 knowledgeInjection 的覆盖情况
- 你发现的、可能阻碍本任务包的前 3 个风险

---

## 3. PR 序列总览

| PR | 主题 | 依赖 |
| --- | --- | --- |
| PR-L0 | 预注册文档与假设冻结（只有文档） | 无 |
| PR-L1 | 程序化场景生成器 + train/held-out 分池 | L0 |
| PR-L2 | 结局归因：决策结局回写注入知识的 evidence | L1 |
| PR-L3 | Thompson Sampling 检索排序（种子化确定性） | L2 |
| PR-L4 | ε-探索与反事实边际价值日志 | L3 |
| PR-L5 | 学习曲线指标进 analyzer | L1（可与 L2-L4 并行开发，最后合并） |
| PR-L6 | 双臂实验 harness 接线 + 3h 压缩预检 | L1–L5 全部 |
| RUN-L7 | 正式 24h 双臂 run + 判定 + 白皮书 v2 + 基线冻结 | L6 |
| PR-L8（可选） | 权重级学习第三臂（LoRA + DPO provider） | **仅当 RUN-L7 的 H1 PASS** |
| MISSION-L9（后续） | Librarian 因果化晋级/淘汰（消费 knowledgeROI 证据） | RUN-L7 产出 ROI 证据后立项 |

**全局验收门（每个 PR 合并前都必须全绿）：**

```
npm --prefix alaya-app run check   # TypeScript 0 error
npm --prefix alaya-app test        # App tests 全绿
npm run test:scripts               # Script tests 全绿
npm run guard                      # Principles guard 全部通过
npm run test:all                   # 全套测试
npm run secret:scan                # 无高置信 secret
```

CI（Alaya CI / Deploy Readiness / Principles Guard）在 PR 分支 HEAD 上全绿才允许合并。分支绿不等于验收——RUN-L7 的正式证据目录才是最终验收。

---

## TASK PR-L0：预注册文档与假设冻结

**目标：** 在写任何代码之前，冻结实验设计。防止后续实现向着「容易通过」的方向漂移。

**产出文件：**

- `docs/validation/EXPERIMENT_PREREG_learning_loop.md` — 按本文档 §10 的模板填写并冻结
- `docs/ai/CODEX_MISSION_learning_loop.md` — 本任务书入库

**验收标准：**

1. 预注册包含 H1/H2/H3 的完整假设、判据、α、样本量策略、有效性硬门（§10 模板的每一节都不得留空）。
2. 预注册明确「唯一实验变量 = 知识注入开关」，其余变量全部锁定（provider、model、thinking=disabled、scenario 种子策略、度量代码 commit）。
3. 预注册明确三种（H1）/两种（H2、H3）可发布结局，穷尽且包含 inconclusive 路径。
4. commit 后记录 commit hash 作为不可篡改锚点，写入文档头部。
5. 本 PR 不改任何产品代码或脚本代码。guard 全绿。

---

## TASK PR-L1：程序化场景生成器 + train/held-out 分池

**目标：** 把 6 个固定 case 的 cognition-coverage 扩展为参数化生成器，产出足量可解析（有 ground truth）的 case，并让「存在可学习的世界规则」成为场景的内生属性。

**新增文件：** `scripts/lib/learning-scenario-generator.mjs`

**实现规范：**

1. **世界规则**：定义一组隐藏规则 R（建议 6–10 条），每条规则形如「信号组合 S → 正确决策方向 D」。规则集由 `--world-seed` 决定，同 seed 完全可复现。
2. **case 生成**：每个 case 由某条规则实例化（信号表述做模板化改写，equity-thesis 语言风格延续现有场景），携带显式 `calibrationTruth`（沿用 `decision_matches_expected` 口径）与 `groundTruthDecision` 字段。
3. **分池**：`--split train|heldout`，默认 80/20。held-out case 携带 `pool: "heldout"` 标记；**held-out case 的观察/误差不得进入 Distiller 蒸馏**（在 harness 层过滤，不改产品逻辑；过滤行为写 trace）。
4. **产能**：单个 24h run 配置下可生成并 resolve 的 case 数 ≥ 120（每臂 scored ≥ 60），生成器需提供 `--dry-run --count` 自检输出。
5. **规则可学习性自检**：生成器附带 `--oracle-check` 模式：用规则集直接作答全部 case，准确率必须 = 100%（证明 ground truth 自洽）。同时 oracle 作答序列必须导出为 `oracle_answers.json`，供 PR-L5 的 `cumulativeRegret` 直接消费（regret 的 oracle 基准在生成时一次性物化，分析时不重算）。
6. **Brier 可评分性**：每个 case 的 `calibrationTruth` 与声明置信度必须支持 Brier 分数计算（H2 需要准确率和 Brier 双序列）。
7. **GOTRA 换皮约束**：世界规则、信号模板、决策方向必须通过配置文件（如 `scenario-domain.json`）与生成器逻辑分离，使未来可直接换皮为 GOTRA 投研 case（真实预测 resolve 作 ground truth）而不改 harness 与阈值（沿用 equity-thesis 换皮保持 harness 不变量的既有纪律）。

**测试要求（必须写，必须通过）：**

```
scripts/tests/learning-scenario-generator.test.mjs
// test 1: 同 world-seed 两次生成，case 序列完全一致（字节级）
// test 2: train/heldout 池不重叠，比例符合参数
// test 3: --oracle-check 输出 accuracy=1.0
// test 4: 每个 case 都含 calibrationTruth 与 groundTruthDecision
// test 5: 不同 world-seed 生成的规则集不同
// test 6: --oracle-check 导出的 oracle_answers.json 与 case 序列一一对应
// test 7: 域配置（scenario-domain.json）替换后生成器逻辑路径不变（换皮隔离）
```

**验收标准：**

1. 上述 7 个测试全绿；全局验收门全绿。
2. 30 分钟 smoke run（mock provider）能走通生成 → 注入 → resolve 全链路，`shadow-analyze.mjs` 不报 schema 错误。
3. 生成器只存在于 `scripts/`，不进产品运行时（PRINCIPLES 运行时边界）。

---

## TASK PR-L2：结局归因（credit assignment）

**这是整个任务包中最重要的一项。**

**目标：** 当一个 cycle 的预测 resolve 时，把决策结局回写到该 cycle 被注入的知识条目的 evidence 上，使知识置信度第一次由「对决策的实际贡献」驱动。

**实现规范：**

```
新增文件: alaya-app/server/knowledgeCredit.ts
核心函数（纯函数 + 薄写入层分离）:
  computeCreditUpdates(injectedIds, outcome): CreditUpdate[]   // 纯函数，可单测
  applyCreditUpdates(updates, ctx): void                        // 走 storage 审计写路径

逻辑:
1. 预测 resolve 时（flywheel.ts 的 resolve 路径挂钩），读取该 cycle trace 中的
   injectedKnowledgeIds（数据已存在，不需要新增记录点）。
2. 决策正确 → 每条被注入知识 evidence_alpha += 1；错误 → evidence_beta += 1。
3. 每次更新写 knowledge_items 审计 event（op: "credit"，before/after 完整），actor
   固定为 "knowledge_credit"。
4. 幂等：同一 (cycleId, knowledgeId) 只归因一次；重复 resolve 不得重复计数。
   用事件表查重或专用去重键实现，写单测覆盖。
5. 状态跃迁仍走现有 knowledgeReview 生命周期与人工闸门。本 PR 只改 evidence 数值，
   不新增任何绕过闸门的晋级路径。
```

**测试要求（必须写，必须通过）：**

```
alaya-app/tests/knowledgeCredit.test.ts
// test 1: 正确结局 → 被注入知识 alpha+1，beta 不变
// test 2: 错误结局 → beta+1，alpha 不变
// test 3: 未被注入的知识不受影响
// test 4: 同一 cycle 重复 resolve 不重复计数（幂等）
// test 5: 每次归因产生 op="credit" 的审计 event，before/after 可比对
// test 6: computeCreditUpdates 是纯函数（同输入同输出，无 IO）
```

**验收标准：**

1. 6 个测试全绿；全局验收门全绿。
2. mock 模式 `e2e:knowledge-lifecycle` 仍全绿（不破坏现有生命周期）。
3. 30 分钟 smoke run 后抽查 3 条被注入知识：其 alpha/beta 变动与审计 event 逐条对得上（在 PR 描述中贴出核对记录）。

---

## TASK PR-L3：Thompson Sampling 检索排序

**目标：** 把注入排序从静态 `confidence_score DESC` 改为 Beta 后验采样排序，形成「结局 → evidence → 注入概率」的强化闭环。

**实现规范：**

```
修改: alaya-app/server/knowledgeInjection.ts
1. FTS5/BM25 召回候选集（LIMIT 放宽到 20，召回逻辑不变）。
2. 对每个候选，从 Beta(evidence_alpha, evidence_beta) 采样一个值，按采样值降序取 top-5。
3. RNG 必须种子化：seed = f(cycleId, ALAYA_RUN_SEED)，同 seed 同输入 → 同排序（回放性）。
   新增纯函数 sampleBetaSeeded(alpha, beta, seed)，放 shared 或 core，可单测。
4. trace 的 knowledge_injection 事件新增字段: rankingMode ("thompson" | "static")、
   perItemSample（每个候选的采样值）、candidateIds。
5. 配置开关 ALAYA_KNOWLEDGE_RANKING=static|thompson，默认 thompson；static 保留为
   回归对照与回退路径。
```

**测试要求（必须写，必须通过）：**

```
alaya-app/tests/knowledgeInjection.thompson.test.ts
// test 1: 同 seed 同候选集 → 排序完全一致（确定性）
// test 2: 不同 seed → 排序分布不同（非退化）
// test 3: alpha 远大于 beta 的知识，在大量 seed 下入选频率显著更高（统计断言，固定 seed 集）
// test 4: ALAYA_KNOWLEDGE_RANKING=static 时行为与改动前逐字节一致（回归保护）
// test 5: trace 事件含 rankingMode 与 perItemSample
```

**验收标准：**

1. 5 个测试全绿；全局验收门全绿。
2. `sampleBetaSeeded` 为纯函数且有独立单测（含边界 alpha=1,beta=1）。
3. 回放验证：同一 run dir、同 seed 重放 10 个 cycle，注入序列完全一致（PR 描述贴证据）。

---

## TASK PR-L4：ε-探索与反事实边际价值日志

**目标：** 用受控随机丢弃同时获得 (a) bandit 探索，(b) 每条知识边际价值的无偏估计。这是 Librarian 未来因果化晋级/淘汰的证据来源。

**实现规范：**

```
修改: alaya-app/server/knowledgeInjection.ts（在 thompson 排序之后）
1. 以概率 ε（ALAYA_INJECTION_EPSILON，默认 0.1）随机丢弃 top-5 中的一条（种子化 RNG，
   与 L3 同一 seed 体系但独立流，防止相关性污染）。
2. trace 事件新增: droppedKnowledgeId（可为 null）、epsilon、explorationSeed。
3. 丢弃只影响本次注入内容，不改知识状态、不写 evidence。
4. 新增纯函数 estimateMarginalValue(traceEvents, outcomes): Map<knowledgeId, {withN, withoutN, withAcc, withoutAcc, delta}>
   位置: scripts/lib/knowledge-roi.mjs（分析侧，不进产品运行时）。
5. 本 PR 不改任何晋级/淘汰逻辑——只生产证据。用证据改 Librarian 是后续独立 MISSION。
```

**测试要求（必须写，必须通过）：**

```
alaya-app/tests/knowledgeInjection.epsilon.test.ts
// test 1: epsilon=0 时永不丢弃，注入与 L3 行为一致
// test 2: epsilon=1 时每次恰好丢弃一条
// test 3: 同 seed 丢弃决策可复现
// test 4: 丢弃不产生 evidence/状态写入
scripts/tests/knowledge-roi.test.mjs
// test 5: 构造合成 trace，estimateMarginalValue 输出的 delta 与手算一致
// test 6: 样本不足（withN 或 withoutN < 5）的知识标记 LOW_COVERAGE，不给 delta 点估计
```

**验收标准：** 6 个测试全绿；全局验收门全绿；30 分钟 smoke 的 trace 中能看到非空 `droppedKnowledgeId` 事件且比例≈ε（PR 描述贴统计）。

---

## TASK PR-L5：学习曲线指标进 analyzer

**目标：** 让 `shadow-analyze.mjs` / `health-signal-quality.mjs` 能度量「学习」本身。

**新增指标与口径（写入 quality_summary.json 与报告 Quality Metrics 区块）：**

| 指标 | 口径 |
| --- | --- |
| `learningCurve` | 按 cycle 分块（块大小可配，默认 10）的决策准确率序列 **与 Brier 分数序列**（双轨报告）；各附 Mann-Kendall 趋势检验的 S 统计量与 p 值 |
| `cumulativeRegret` | 相对 oracle（读 PR-L1 导出的 `oracle_answers.json`，不重算）的累计错误数曲线；报告末段斜率是否低于首段斜率（次线性判据） |
| `knowledgeROI` | 调用 `knowledge-roi.mjs`，输出 delta 分布摘要与 LOW_COVERAGE 计数 |
| `heldOutAccuracy` | pool="heldout" case 的准确率，独立于 train 池报告，scored 计数单列 |
| `forgettingRate` | 前半程已答对的规则类别，在后半程的正确率保持度 |

**纪律要求：** 每个指标必须可下钻到原始 events（沿用 reliabilityTable 纪律）；样本不足时诚实报 LOW_COVERAGE，禁止用小样本输出好看的点估计。

**测试要求（必须写，必须通过）：**

```
scripts/tests/learning-metrics.test.mjs
// test 1: 构造单调改进的合成 run → learningCurve 趋势 p < 0.05 且方向为正
// test 2: 构造无改进的合成 run → 趋势不显著（防假阳性）
// test 3: heldOutAccuracy 只统计 heldout 池，与 train 池计数互不污染
// test 4: 每个新指标在样本不足时输出 LOW_COVERAGE 而非数值
// test 5: 旧指标（ECE/decisionTsr/faithfulness）输出与改动前一致（回归保护）
```

**验收标准：** 5 个测试全绿；全局验收门全绿；对一个 30 分钟 smoke run dir 运行 analyzer，报告含全部新区块且无 schema 错误。

---

## TASK PR-L6：双臂实验 harness 接线 + 3h 压缩预检

**目标：** 把 L1–L5 组装成可一键执行的双臂配对实验，并用 3h 压缩 run 完成 A 类错误筛查。

**实现规范：**

1. harness 支持双臂配置：
   - **baseline 臂**：`ALAYA_KNOWLEDGE_INJECTION=off`（新增总开关，off 时 `buildKnowledgeContext` 恒返回空串并写 trace 标记）
   - **treatment 臂**：注入开 + thompson + ε-探索全开
   - 两臂共享同一 `--world-seed` 与 case 序号集（配对前提），不同 DB / 端口 / log-dir
2. `MINIMAX_THINKING=disabled` 两臂锁死（沿用已冻结基线前提，thinking 不再是变量）。
3. 3h 压缩预检：跑一对压缩双臂，通过 §10 有效性硬门中所有**非时长类**条目。压缩预检是诊断，不是验收（不可替代 24h）。
4. `analysis/extract_phase3_metrics.py` 扩展为可抽取新指标（learningCurve 末块准确率、heldOutAccuracy 等）到 CSV；`phase3_stats.py` 判定逻辑不改，只换输入列。

**测试要求：**

```
scripts/tests/dual-arm-harness.test.mjs
// test 1: ALAYA_KNOWLEDGE_INJECTION=off 时 prompt 中不出现 [PRIOR KNOWLEDGE]
// test 2: 两臂 case 序号集一致（配对校验函数单测）
// test 3: off 开关有 trace 证据（injectionDisabled 事件）
```

**验收标准：**

1. 3 个测试全绿；全局验收门全绿。
2. 3h 压缩双臂预检完成，非时长类硬门全过，预检报告归档到 run dir（不进 git），PR 描述附结论摘要。
3. 预检若暴露任何 A 类错误（schema error、provider 断流、finalDrain 卡死），修复后重跑，直到干净。

---

## TASK RUN-L7：正式 24h 双臂 run + 判定 + 发布（不是代码 PR）

**执行前提：** L0–L6 全部合并进 `main`，代码 commit 锚点冻结并写入预注册。

**执行规范：**

1. 严格按预注册跑 pilot（如预注册要求）与正式配对 run；单个连续 24h 证据目录，≥48 份 metrics 快照，中断即作废重跑（沿用单目录验收纪律）。
2. 结果判定只用 `summary.json` 作为 assessment 来源；reconstruction 仅限中断诊断。
3. 判定严格执行预注册决策规则，禁止任何事后修改（禁止事项见 §10 模板第 8 节）。
4. 产出：
   - `docs/validation/2026-XX-XX-learning-loop-run.md` — run 记录
   - `docs/validation/WHITEPAPER_learning_loop.md` — 白皮书 v2（无论结局是阳性、等效还是 inconclusive 都要写，结论如实）
   - 若 H1 PASS 且硬门全绿 → 打 tag `baseline/learning-loop-<date>` 冻结新基线
5. README「认知质量验证」区块更新为新结论，措辞不得超出统计证据支持范围。

**验收标准（run 级硬门，任何一条不过则该 run 作废）：** 见 §10 模板第 5 节，全部适用。

---

## 10. 预注册模板（PR-L0 据此填写 `EXPERIMENT_PREREG_learning_loop.md`）

```markdown
# Alaya 认知增强 · 知识飞轮消融实验 · 预注册

> **预注册时间戳**：<冻结时的 commit 时间>
> **冻结代码锚点**：commit `<L6 合并后的 main HEAD>`（度量与注入逻辑以此为准，实验期间不得修改）
> **分支**：`codex/learning-loop`
> **核验纪律**：永不只看汇总指标下结论；必须下钻原始 events 验证样本有效性。

## 1. 研究问题与对外结论目标

**问题**：知识飞轮（注入 + 结局归因 + Thompson 排序 + ε-探索）是否使 Alaya 的
决策质量产生可发布的显著提升？

**主指标**：配对 case 决策准确率（decisionAccuracy，按 groundTruthDecision 判定）。
**次指标**：ECE（沿用 c0319d15 口径）、heldOutAccuracy、learningCurve 趋势。
次指标不参与 H1 主判定，主失败不可被次指标抵消。

## 2. 假设（事前冻结，事后不得修改）

配对设计：第 i 个 replicate 中两臂共享同一 world-seed 与 case 序号集，定义
d_i = accuracy_treatment_i − accuracy_baseline_i（正值表示知识飞轮更好）。

**H1 主判据 — 优越性（单侧配对 t）**
- H0: μ_d ≤ 0；H1: μ_d > 0；α = 0.05（单侧）
- PASS：p < 0.05 且方向为正。

**H1 回退判据 — 等效性（TOST），仅当主判据不显著时启用**
- 等效边界 Δ = <事前定义，建议 0.05 个准确率点，须在看到任何重复数据前给出理由>
- 两个单侧检验均拒绝 → 判「知识飞轮无实践收益」。

**H1 三种可发布结局（穷尽）**
1. 主判据显著 → 「知识飞轮显著提升决策质量」。
2. 不显著但 TOST 成立 → 「±Δ 内等效，飞轮现形态无收益」。
3. 均不成立 → inconclusive + 所需 N。绝不包装成任一方向强结论。

**H2 — 学习曲线（treatment 臂内部）**
- 主序列：分块准确率；Mann-Kendall 趋势检验，α = 0.05，方向为正判 PASS。
- 副序列：分块 Brier 分数（方向为降），仅描述性报告，不参与 H2 判定。
- 结局二元：PASS / not-supported，均可发布。

**H3 — 泛化（heldout 池）**
- 对 heldout 池单独重复 H1 主判据。
- heldout scored < 预注册门槛时判 LOW_COVERAGE，不给方向性结论。

## 3. 样本量与功效（事前 power analysis）

- 用 analysis/phase3_pilot_decision.py，跑 <k> 对 pilot 估计 σ_d。
- 两阶段规则（照抄 Phase3 结构）：σ_d 阈值表、n 上限、pilot 计入最终样本、
  N 在阶段 B 首个新 run 前冻结并 commit。
- 每 run 有效性门槛：train 池 scored ≥ 60/臂，heldout 池 scored ≥ 20/臂。

## 4. 变量锁定（单变量原则）

唯一允许变化的变量：ALAYA_KNOWLEDGE_INJECTION ∈ {off, on(full)}。
其余全部锁死：

| 项 | 锁定值 |
|---|---|
| 代码 | commit <锚点> |
| scenario | learning-scenario-generator，world-seed 集合事前列出 |
| Provider | openai-compatible / MiniMax-M3 / MINIMax_THINKING=disabled（两臂相同） |
| Scheduler | 与 Phase3 相同锁定 |
| 排序/探索参数 | thompson + ε=0.1（treatment 臂内固定） |
| 度量 | health-signal-quality.mjs @ 锚点 commit |
| 配对 | 两臂同 world-seed、同 case 序号集、不同 DB/端口/log-dir |

## 5. 有效性硬门（每 run 必须全过，否则作废重跑，不计入）

1. assessment 来自自然 summary.json（非中途快照）
2. train scored ≥ 60/臂；heldout scored ≥ 20/臂；scoreableCoverage ≥ 0.6
3. correctnessMode 全为 truth（groundTruthDecision 判定），非 oracle 回退
4. providerRatio = 1.0（tokenSourceProvider ≥ 95%）
5. 错误门全 0（schema_error 等）
6. 下钻抽查：随机抽 ≥10 个 case，人工核对 groundTruth 与判分一致；
   heldout case 无一进入 Distiller（trace 证据）
7. watchdog 全绿 + finalDrain complete
8. 治理红线抽查：credit/thompson/epsilon 全部写路径有审计 event，无绕过闸门的状态跃迁
9. 单个连续 24h 证据目录，≥48 份 metrics 快照

## 6. 等效边界 Δ 的事前理由

<在看到任何重复 run 数据之前写下：为什么 Δ 以下的准确率差异对下游投研决策
不构成可操作差异。禁止把观测效应当边界。>

## 7. 统计分析计划（锁定）

- 主分析：单侧配对 t（analysis/phase3_stats.py，只换输入列不改逻辑）。
- 正态性：Shapiro-Wilk；小样本偏态附 Wilcoxon 作稳健性（不替换主判据）。
- H2：Mann-Kendall；H3：与 H1 同框架。
- 多重比较：H1 为唯一主结论；H2/H3 为预注册的次要命题，按各自判据独立报告，
  不得用 H2/H3 的阳性弥补 H1 的失败。
- 分析脚本在 pilot 前冻结，跑数据时不改代码。

## 8. 不允许的事后操作（明令禁止）

- 修改 Δ、α、N、块大小、门槛以迁就已见数据
- 以任何理由剔除已通过硬门的 run；作废 run 必须留档并说明触发的硬门条目
- 用 train 池结果冒充 heldout 结论
- 修改世界规则或生成器参数后继续沿用旧预注册
- 把 inconclusive 包装成方向性结论
- 复用中断 run 的重建数据作为 PASS 依据
```

---

## 9. TASK PR-L8（可选）：权重级学习第三臂

**触发条件（硬门，缺一不可）：** RUN-L7 的 H1 主判据 PASS；且人类明确批准立项。H1 未达标时本任务**禁止启动**（系统级学习都未证明有效时，权重级投入无因果依据）。

**目标：** 把系统级学习验证过的高价值知识转化为权重级学习，并用同一套实验纪律验证它是否带来增量收益。

**实现规范：**

1. **数据导出**：新增 `scripts/export-preference-pairs.mjs`，从审计日志与 knowledgeROI 证据导出偏好对：
   - chosen = 高 ROI 知识（delta > 0 且非 LOW_COVERAGE）参与且决策正确的 (context, decision)
   - rejected = 同 context 下的错误决策或被 supersede 的错误侧知识对应决策
   - held-out 池数据**绝不导出**（泛化评估保持未污染）
2. **训练**：开源模型 + LoRA + DPO，训练脚本与权重不进本仓库（外部证据纪律）；仓库内只保留导出脚本、训练配置清单与评估报告。
3. **接入**：微调后模型作为独立 OpenAI-compatible provider 接入现有 LLMProvider 隔离层，**不新增任何产品侧特殊分支**；对产品代码而言它只是又一个 endpoint。
4. **验证**：三臂预注册实验（新开 PREREG，沿用 §10 模板结构）：
   - A：基础模型 + 知识飞轮关
   - B：基础模型 + 知识飞轮开（= RUN-L7 treatment，作为锦标臂）
   - C：微调模型 + 知识飞轮开
   - 主命题：C vs B 的配对优越性（权重级学习的**增量**收益），判据、硬门、禁止事项与 §10 同构。

**验收标准：**

1. 导出脚本有单测：held-out 数据零泄漏（构造含 heldout 标记的合成日志，断言导出为空）；chosen/rejected 构造规则与手算一致。
2. 新 provider 通过现有 providerCanary 与结构化输出 contract 检查。
3. 三臂实验有独立预注册 commit 锚点；判定按预注册执行；结论（含 null）入白皮书 v3。
4. 全局验收门全绿；PRINCIPLES 6 条红线无一突破（尤其 LLMProvider 隔离）。

---

## 11. 完成定义（Definition of Done）

本 MISSION 视为完成，当且仅当：

1. PR-L0 至 PR-L6 全部合并进 `main`，每个 PR 的验收标准逐条满足，CI 全绿。
2. RUN-L7 产出一个通过全部硬门的正式双臂证据目录，判定按预注册执行完毕。
3. 白皮书 v2 与 run 记录入库，README 结论区更新且措辞不超出证据。
4. 无论 H1 结局如何，向人类提交一份**下一步建议**，二选一：
   - **阳性** → (a) MISSION-L9 草案：Librarian 用 knowledgeROI 证据做因果化晋级/降级/淘汰，替换现有纯启发式 gray lifecycle 判断（仍保留强知识人工闸门）；(b) PR-L8 权重级学习立项建议（见 §9，需人类批准）；(c) GOTRA 换皮方案：用 scenario-domain 配置将生成器切到投研 case，以真实预测 resolve 作 ground truth，同一套机制两处复用。
   - **等效/ inconclusive** → 机制诊断清单（注入内容质量、检索召回率、ε 设置、场景难度与规则可学性）+ 每项诊断对应的可测量假设；PR-L8 维持禁止状态。

> 最后提醒：这个任务包的价值不在于拿到阳性结果，而在于第一次对**正确的变量**做出可发布的回答。诚实的等效或 inconclusive 与阳性结果同等合格。
