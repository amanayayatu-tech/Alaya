# Alaya learning-loop v2 威胁模型

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：2.1.0 增加威胁：把已见光的 2.0.0 OPE 数字写进新版门槛。控制：另开版本、先冻阈值、再生成种子。
- 范围：Experience ledger、simulator、replay、OPE、dry shadow、held-out、approval 与 evidence gates

## 1. 受保护资产

1. experiment/run/decision/case 的唯一身份与 authoritative ordering；
2. context、candidate、action、propensity、request、outcome、reward 的因果链；
3. 人类 approval provenance 与 Alaya `strong` 晋级闸；
4. held-out 隔离与 oracle confidentiality；
5. provider authorization、预算与 latched stop；
6. reference evaluator、acceptance corpus 与 gate attestation 的独立性；
7. v1 failed evidence 与 v2 evidence 的不可混用边界。

## 2. 对手与失败来源

- 意外 bug：race、retry、crash、partial write、clock skew、schema drift、PRNG/runtime drift；
- 有激励的实现者：修改 reward、阈值、corpus、exclude rule 或日志以让 gate 变绿；
- prompt/log/repo 注入：不可信文本诱导工具越权、provider call 或证据升级；
- 低权限调用者：伪造 actor/count、重放 grant、跨 run 注入 reward；
- 管理员/CI 风险：同仓库脚本自批、workflow 被 PR 修改、credential 未绑定 manifest；
- 数据泄漏：held-out case/oracle 经 prompt、cache、telemetry 或调参反馈进入 learner。

## 3. Threat/control matrix

| Threat | 必须控制 | 冻结反例 | 失败状态 |
| --- | --- | --- | --- |
| provider-before-action | action transaction commit 后才签发短期 dispatch token | 无 action event 但存在 provider start | `CONTRACT_FAIL` |
| equal credit | reward unique join；B0 single action；禁止 item fan-out | A 好/B 坏但总一起出现 | `FORMALIZATION_FAIL` |
| post-treatment propensity | feature allowlist + action-commit timestamp/order proof | 使用 output/latency/render-result 调概率 | `OPE_NOT_IDENTIFIED` |
| propensity spoof | 完整 probability vectors + 独立重算 | corrupt vector、sum != 1、target p=0 | `OPE_NOT_IDENTIFIED` |
| timestamp reordering | `(streamId,streamSequence)` 唯一 authoritative | same timestamp/different IDs、shuffle | `REPLAY_FAIL` |
| duplicate/conflicting reward | idempotency + unique FK + append-only rejection | same key same/different digest | `CONTRACT_FAIL` |
| cross-run/case reward | composite FK 与 manifest binding | wrong run/case/rewardVersion | `CONTRACT_FAIL` |
| approval spoof/replay | signed subject grant + nonce + revoke + atomic consume | actor string、count、自批、wrong subject | `CONTRACT_FAIL` |
| held-out leakage | separate process/DB/ACL/credential；one-way checkpoint copy | alias path、train write、telemetry feedback | `CONTRACT_FAIL` |
| evaluator self-approval | independent implementation、digest、CODEOWNER/attestation | production evaluator 与 reference 同 import | `EVALUATOR_FAIL` |
| fail-after-retry | first hard failure latched before every authorization/start | callback/retry after latch | `DRY_SHADOW_FAIL` |
| version drift | immutable manifest + automatic experiment version bump | schema/reward/policy diff without bump | `MANIFEST_INVALID` |
| v1 contamination | explicit freeze manifest + fresh v2 priors/ledger | old DB/checkpoint/reward imported | `EVIDENCE_CONTAMINATED` |
| prompt injection | repository/log/external text treated as data; fixed command allowlist | artifact asks to expand scope/call provider | `SCOPE_VIOLATION` |

## 4. Fail-closed invariants

- 任何无法确定 exposure 的 provider attempt 标为 `UNKNOWN/QUARANTINED`，不能重试为同一 clean decision。
- crash recovery只能返回已提交的同 digest结果或追加补偿/隔离事件，不能覆盖历史。
- first contract/safety/approval failure 后，新的 provider authorization/start 数量必须为 0。
- 无 safe action、无 exact propensity、无 oracle、无独立 evaluator或无 manifest digest 时必须 no-op/stop。
- gate artifact缺失时结论是 `BLOCKED` 或 `FAIL`，不是根据线程叙述补齐。

## 5. 权限隔离

- 实现者：可写 product implementation，但不能写 reference evaluator、frozen corpus、gate attestation。
- Reviewer/Judge：只读实现与 raw evidence；签署绑定 artifact digest 的 verdict。
- held-out actor：只读 frozen checkpoint；无 learner endpoint、train DB 或 active-knowledge 写权限。
- provider credential broker：仅接受已签署 manifest 与 gate attestation；Gates 1–7 永不签发真实 provider credential。
- repo CI：只能产 local-check artifact，不能产 formal/science/public attestation。

## 6. Residual risk 与 claim ceiling

同仓库文档和测试无法抵御管理员绕过，也无法证明真实 provider 行为或统计功效。Gates 1–7 即使全部通过，也只表示离线架构具备进入独立 canary 审批的先决条件；当前 Goal 只覆盖 Gate 1 的 `REVIEW_READY` 材料。
