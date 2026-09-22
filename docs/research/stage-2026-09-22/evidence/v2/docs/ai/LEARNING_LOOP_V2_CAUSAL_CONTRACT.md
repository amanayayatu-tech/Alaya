# Alaya learning-loop v2 因果合同

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：2.1.0 不改变 estimand。G5 统计门槛在新种子前冻结，见 LEARNING_LOOP_V2_G5_OPE_AMENDMENT.json。
- 证据范围：Gates 1–7 离线架构

## 1. 单位、处理与结果

- 决策单位：一次完整 `decisionId`，对应一个 horizon-one episode。
- 随机化单位：完整 `(worldSeed, providerSeed, policySeed, manifestDigest)` trajectory pair；trajectory 内 decisions 是 repeated observations，不是 iid replicates。
- B0 action：`no-op` 或 `inject-one-item(itemVersion)`，二者都必须有正 support。
- B1 action：不在 v2 Gates 1–7 的实现权限内。
- delivered treatment：模型实际收到的 canonical rendered bytes；proposed item 在过滤或 token budget 后未交付时不得算 exposed。
- primary outcome：独立 oracle/evaluator 输出的 binary correctness；缺失不是自动正确，也不能由模型输出反推 label。
- 其他 endpoint：abstention、Brier/calibration、latency、cost、safety/approval violation、contract/reliability failure，分别报告，禁止压成可互相抵消的单一 reward。

## 2. DAG 与允许的调整集

```text
pre-treatment context X -> candidate set C -> delivered action A -> output O -> outcome Y
X -> O
policy contract/checkpoint P -> A
logged RNG U -> A
provider/model block M -> O
external approval/safety G -> eligible set -> A
independent oracle Q -> evaluator -> reward R
R(train only) -> offline learner -> next checkpoint P'
```

propensity/reward model只能使用 action commit 前冻结的 `X/C/P/U/G/M`。模型输出、render 后 token count、response latency、outcome、reward、future checkpoint 或任何受 action 影响的字段都是 post-treatment，禁止进入 logging propensity 或主因果调整集。

## 3. Estimands

### E0: injection value

`Delta_inject = E_seed[mean(Y_static - Y_no-injection)]`

这是 frozen static injection 相对 strict no-injection 的 deployment-bundle ITT。若没有同 token placebo arm，不得解释为纯知识内容效应。

### E1: online-learning increment

`Delta_online = E_seed[mean_t(Y_bandit,t - Y_static,t)]`

E1 只有在 E0 positive、B0 获得新授权并签署独立 prereg 后才可运行。

### H3: frozen generalization

`Delta_heldout = E_train-seed,eval-world[mean(Y_frozen-bandit - Y_frozen-static)]`

train checkpoint 与 eval world 是 crossed factors；其 cells 不得当 iid observations。

Gates 1–7 不估计上述真实 provider effects，只证明日志、replay、simulator 与 OPE 是否具备测量条件。

## 4. 识别假设

每份可评估 manifest 必须逐项声明并验证：

1. consistency：记录的 delivered action 与实际 exposure bytes 完全一致；
2. positivity：target policy 有质量的 action 在 logging policy 下 propensity `> 0`；unsupported target mass 必须为 0；
3. sequential ignorability：给定全部 pre-treatment context 与预注册随机化，action assignment 不依赖潜在结果；
4. no hidden versions：context、candidate、policy、renderer、provider/model 与 evaluator revision 均被 digest 锚定；
5. interference boundary：默认一个 decision 的 action 不改变同一 trajectory 内其他 arm 的 prompt、candidate、world 或 oracle；共享缓存、知识库写入或 provider conversation 会破坏该假设并使 pair invalid；
6. reward consistency：训练 credit、评估 metric 与 reference evaluator使用同一 `rewardVersion`；
7. censoring/missingness：按 prereg 的 arm-blinded rule处理，不得事后选择性补位。

任一假设无法验证时，结论为 `NOT_IDENTIFIED`，不是负效果或等效。

## 5. Propensity 合同

- 记录每个 slot 对全部 remaining eligible actions 的完整 probability vector，元素和必须为 1。
- 记录 conditional per-slot propensity 与 joint path propensity。
- proposed action 经确定性 transform 映射为 delivered action时，effective propensity 等于所有映射到同一 delivered action 的 proposed paths 概率之和。
- seed 只支持重放一次 draw，不等同于选择概率。
- inclusion probability、slot probability 与 joint probability 不得混称。
- 概率为 0、缺失、非有限数、超出 `(0,1]` 或与向量重算不一致时，OPE hard fail。

## 6. Reward 与 credit

- `rewardEventId` 必须唯一引用 accepted outcome、oracle 和 evaluator digest。
- 同一 slate-level reward 禁止等量复制给多个 item。
- B0 只学习 single intervention action value。
- B1 若未来只有 global slate reward，只能使用明确的 slate-level model；只有真实 per-item/slot outcome 才允许 semi-bandit credit。
- human override 是独立 policy/version，不是正 reward。
- safety/approval failure 是硬约束 endpoint，不得由 correctness 抵消。

## 7. OPE 边界

Gate 5 Replay & OPE 允许 IPS、SNIPS、DR、SWITCH 仅在 deterministic simulator 同时提供 target policy online truth 时校准。每次报告必须含：

- target/logging policy digest；
- unsupported mass；
- weight distribution、max weight 与 clipping rule；
- effective sample size；
- point estimate、interval、bias against online truth 与 coverage over frozen seed ensemble；
- missing/invalid decision denominator。

没有 exact propensity、support 或预注册阈值时，输出 `OPE_NOT_IDENTIFIED`，禁止输出“可用但低置信”的效果值。

## 8. Held-out 与 approval

- held-out split 在任何学习、prompt exposure 或调参前冻结；learner 对 held-out DB/ledger 无写权限。
- held-out telemetry 不得回流 candidate generation、credit、usage/ROI projection 或 checkpoint selection。
- approval grant 必须 subject/version-bound、principal-signed、一次性、可撤销且先于 action；grant consume 与 action/promotion commit 使用同一 transaction/CAS。
- actor string、`humanApprovedCount` 或事后 approval 不能证明授权。
