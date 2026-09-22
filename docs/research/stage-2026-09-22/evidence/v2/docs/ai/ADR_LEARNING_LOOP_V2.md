# ADR-LL-V2: Alaya learning-loop v2 离线架构

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：2.1.0 仅因 2.0.0 样本已见光而另开版本；架构决策不变。统计阈值见 G4/G5 amendment，不得回填 2.0.0 的 ESS/coverage/bias。
- 日期：2026-07-13
- 适用实验族：`alaya-learning-loop-v2`
- 当前证据层：`local checks`
- 决策者：独立 Reviewer/Judge；实现者无权把本 ADR 改为 `PASS`

## 1. 决策

Alaya v2 在 Gates 1–7 内采用“严格无注入安全回退 + 冻结静态 reranker + 可审计的 horizon-one contextual bandit 研究接口”的架构。当前不实现在线 learner，不运行 provider，不实现 slate learner，也不把该问题描述为完整 MDP/RL。

决策顺序固定为：

1. E0 前产品安全回退是 strict no-injection；冻结静态 reranker 只作为离线候选，不是已证明有效的产品默认。
2. 首个研究 learner 只能是 B0 single intervention，action set 为 `{no-op, inject-one-item}`。
3. B0 只有在 E0 阳性证据和新的明确人类授权后才可实现；本版本只定义合同。
4. B1 slate learner 只有在 B0 的 support、propensity、OPE、held-out 和治理证据成立后另立版本。
5. 完整 MDP/deep RL、RLHF、DPO、LoRA 不属于本实验族。

## 2. 问题定义

每个 `decisionId` 是一个终止于单次 outcome 的 horizon-one episode：

```text
pre-treatment context -> eligible action set -> committed action
-> optional provider exposure -> outcome -> independently evaluated reward -> terminal
```

learner checkpoint 的变化属于跨 episode 的 learner state，不是环境 transition。没有 action-dependent multi-step environment、delayed return 或长期价值 estimand时，不得使用 MDP/RL claim。

详细 estimand、DAG 与可识别性约束见 [LEARNING_LOOP_V2_CAUSAL_CONTRACT.md](LEARNING_LOOP_V2_CAUSAL_CONTRACT.md)。

## 3. 组件与信任边界

```text
immutable registry
  -> context/candidate snapshot
  -> external safety and human-approval filter
  -> auditable stochastic logging policy
  -> deterministic render and token-budget transform
  -> ACTION_COMMITTED append-only event
  -> dispatch authorization boundary
  -> outcome ledger
  -> independent reference evaluator
  -> unique accepted reward
  -> offline-only learner/OPE input
```

核心边界：

- policy 只能在 `A_safe(x)` 内选择；无安全 action 时必须选择 `no-op`。
- proposed action 与 delivered action 都必须记录。过滤、截断或 render 后的 action 才能绑定 reward。
- action、renderer bytes、request digest、propensity 必须先原子提交，之后才能取得 dispatch authorization。
- evaluator 不得 import 被测 evaluator，也不得与实现者共享 reward、阈值或 acceptance corpus 的写权限。
- held-out enclave 与 learner 在 process、DB、credential/ACL 上隔离。
- replay 只消费已记录 response；不得发起新 provider request。

## 4. Experience ledger 最小不变量

1. `decisionId` 在 experiment version 内全局唯一；`episodeId == decisionId`，`stepIndex == 0`，`terminal == true`。
2. authoritative ordering 只使用唯一 `(streamId, streamSequence)`；timestamp 仅用于诊断。
3. context、完整 ordered candidate set、constraint result、policy contract/checkpoint、proposed/delivered action、slot/joint propensity、renderer/request digest在同一 action transaction 内冻结。
4. provider call 必须引用 committed action event；无引用则 fail closed。
5. accepted reward 必须唯一 join 同一 `experimentId/runId/decisionId/caseId/rewardVersion`。
6. missing、late、cross-run、wrong-case、duplicate-conflicting 或 malformed reward 只产生 rejection/quarantine event，绝不 credit。
7. evidence ledger 禁止 UPDATE、DELETE、`INSERT OR REPLACE`；projection 可更新，但不能作为正式证据源。
8. 同 idempotency key + 同 payload digest 返回既有结果；同 key + 异 digest hard conflict。
9. schema、policy contract、reward、evaluator 或 constraint contract 的实质变化必须升级 experiment version。
10. `learner_update_inputs` 只能引用 accepted train reward；held-out reward 永远不能成为 learner input。

### 4.1 Gate 2 实现绑定

- canonical stream 是 `learning_loop_v2_events`；`sequence INTEGER PRIMARY KEY AUTOINCREMENT` 是唯一排序，`recorded_at` 不参与因果排序。
- 事件序列固定使用 `EXPERIMENT_CREATED`、`VERSION_REGISTERED`、`RUN_STARTED`、`DECISION_RECORDED`、`ACTION_COMMITTED`、`ACTION_AUTHORIZED`、`OUTCOME_RECORDED`、`REWARD_RECORDED|REWARD_QUARANTINED`、`CREDIT_RECORDED`。
- `ACTION_COMMITTED` 与 `ACTION_AUTHORIZED` 属于两个独立、已提交 transaction；只有前者已持久化，后者才可生成。当前授权类型仅为 `offline_stub`，`realSideEffectAllowed=false`。
- event table 由 SQLite trigger 禁止 `UPDATE`/`DELETE`，并以 `previous_event_digest`/`event_digest` 形成全局 hash chain；idempotency key 与 payload digest 冲突时 hard fail。
- partial unique indexes 将 decision→action、action→outcome、outcome→terminal reward、reward→credit 限制为唯一 join；无效或 unsupported-slate reward 只可进入 `REWARD_QUARANTINED`。
- `CREDIT_RECORDED` 仅记录 provenance，固定 `learnerUpdateApplied=false`；它不是 B0 online learner，也不改变任何 checkpoint。
- 所有 read model 由 immutable events 按 `sequence` 重建；本 Gate 不引入可作为证据源的 mutable projection table。

## 5. Gate 与 canonical roadmap 的唯一映射

Gate 顺序以 canonical Goal Queue 与 milestone registry 为唯一执行顺序，不使用第二套独立排序：

| Gate | Canonical milestone / Goal | 作用域 |
| --- | --- | --- |
| 1 Formalization | `M0-V2-FORMALIZATION` / `ALAYA-V2-G0` | ADR、因果合同、威胁模型、evaluator、离线 prereg 与 v1 freeze |
| 2 Experience Contract | `M1-EXPERIENCE-CONTRACT` / `ALAYA-V2-G1` | append-only Experience ledger、action-before-dispatch、唯一 causal join、idempotency、crash/property/fuzz/mutation fail-closed |
| 3 Baseline Exposure | `M2-BASELINE-EXPOSURE` / `ALAYA-V2-G2` | strict no-injection 与 frozen-static baseline；proposed/delivered exposure 与 propensity 可审计 |
| 4 Simulator & Counterexamples | `M3-SIMULATOR-COUNTEREXAMPLES` / `ALAYA-V2-G3` | deterministic worlds、known optimum、wrong-learner 与 frozen adversarial corpus |
| 5 Replay & OPE | `M4-REPLAY-OPE` / `ALAYA-V2-G4` | byte-stable golden replay；support、ESS、bias、coverage 与 `OPE_NOT_IDENTIFIED` |
| 6 Isolation & Dry Shadow | `M5-ISOLATION-DRY-SHADOW` / `ALAYA-V2-G5` | held-out、approval、credential/request 隔离；zero-side-effect dry shadow |
| 7 Offline Closeout | `M6-OFFLINE-CLOSEOUT` / `ALAYA-V2-G6` | exact evidence closure 与独立、未获授权的 E0 provider decision |

G2 的 contract/property/fuzz/mutation、G4 的 simulator/counterexamples 与 G5 的 replay/OPE 是各自 milestone 内的组合 gate，不是可重排的额外 gate。Baseline Exposure 是明确的 Gate 3；不得因旧 taxonomy 遗漏它而跳过 M2。

任何 gate 都使用：

```text
NOT_STARTED -> REVIEW_READY -> PASS
                         \-> FAIL_1 -> ONE_REPAIR -> RECHECK
                                                  \-> ARCH_REVIEW_REQUIRED
```

- 后一 gate 不得在前一 gate 的 code review、必要的 Local Verification 与 Roadmap Audit 均被 canonical runtime ACK、且对应 milestone 成为唯一 Active 之前开始。
- 同一 experiment version 的同一 gate 第二次失败必须进入 `ARCH_REVIEW_REQUIRED`。
- 实现者只能提交 `REVIEW_READY`；独立 Reviewer/Judge 才能签署 `PASS`。
- Gates 1–7 只支持 offline architecture readiness，不支持 provider、formal、science、product 或 public claim。

## 6. 迁移与回滚

- v1 experiment、prereg、failed-case report、旧 alpha/beta、checkpoint、reward rows、DB 与 `/tmp` run 均保持历史归档身份；不得迁移为 v2 evidence。
- 可复用的仅是经新合同重新验证的通用 substrate 或人工审核后的知识内容；旧学习权重与结果不可复用。
- v2 任一 fail-closed 条件触发时回滚到 strict no-injection，不回滚到 v1 learner。
- v1 精确冻结边界见 [LEARNING_LOOP_V2_V1_EVIDENCE_FREEZE.md](../validation/LEARNING_LOOP_V2_V1_EVIDENCE_FREEZE.md)。

## 7. 明确不决策事项

下列事项不是“待实现时自由解释”，而是必须由新版本和新授权处理：

- E0 真实 provider canary 的 call/token/cost/time cap；
- B0 online learner 实现；
- B1 slate policy、slate reward model 或 item credit；
- confirmatory E0/E1/H3 的最终样本量与业务 utility margin；
- production rollout、release、public/science wording。

## 8. Gate 1 审查清单

Gate 1 仅在独立 Reviewer 确认下列全部成立后可 `PASS`：

- 本 ADR 与 causal、threat、evaluator、prereg、v1 freeze 六份文档版本一致且互不冲突；
- intervention unit、action set、reward、estimand、support、interference、missingness 与 stop rule 无歧义；
- equal-credit、post-treatment propensity、held-out leakage、approval spoof 与 provider-before-action 均被明确禁止；
- v1 文档与失败报告 byte-immutable，且明确不能支持 v2 claim；
- diff 中无 product/script code；
- Reviewer 结论绑定六份 artifact digest，而不是绑定工作线程叙述。
