# Alaya learning-loop v2 独立 evaluator 合同

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：evaluator contract id 升到 2.1.0，因为 G5 统计门槛进入正式输入。实现者输出仍是 REVIEW_READY。
- evaluator contract id：`alaya-ll-v2-evaluator/2.1.0`

## 1. 独立性

reference evaluator 必须：

- 从 raw append-only events 与 frozen manifest 重算，不读取 production projection/summary；
- 不 import production evaluator、learner、policy 或被测 parser；
- reward definition、threshold、oracle adapter 与 critical corpus 由独立 Reviewer ownership保护；
- 对 arm/policy label blinded，直到每个 decision 的 score 与 validity 已冻结；
- 输出绑定 evaluator source/artifact digest、runtime/toolchain digest 与 input manifest digest。

实现者生成的 evaluator 输出只能标为 `candidate`; 只有独立 Reviewer/Judge 的 digest-bound attestation 才能成为 gate verdict。

## 2. 输入合同

### 2.1 Gates 2–7 运行期 profile

Gates 2–7 的必需输入：

1. experiment/run manifest；
2. ordered event range 与 hash/Merkle root；
3. context/candidate/action/propensity/request/outcome/reward schema versions；
4. oracle artifact与 digest；
5. policy contract/checkpoint、renderer、provider/model/config digests；
6. frozen missingness、exclusion、budget、stop 与 gate thresholds；
7. held-out split manifest（如适用）。

在 Gates 2–7 中，任一适用 digest 缺失、不匹配或输入不完整时必须返回 `MANIFEST_INVALID`；不得 best-effort 补值。

### 2.2 Gate 1 静态 formalization profile

Gate 1 使用 `profile = G1_STATIC_FORMALIZATION`，只要求：六份 v2 formalization artifact及各自 SHA-256、Git root/branch/base/head、approved-scope before/after snapshot、完整六文件 diff digest、v1 freeze document中三个 frozen artifact的 SHA-256与独立重算、claim boundary。它不创建 run、event、oracle、policy checkpoint、provider、budget usage或 held-out split。

Gate 1 的确定性占位语义固定为：

- `run_id = "NOT_APPLICABLE"`；
- `event_range = {"stream_id":"NOT_APPLICABLE","first":0,"last":0,"count":0}`；
- `denominators = {}`、`metrics = {}`、`support_diagnostics = {}`；
- oracle、policy checkpoint、renderer、provider/model/config、usage与 held-out字段若统一 schema要求出现，值必须为字符串 `"NOT_APPLICABLE"`，不得伪造 digest或空 run；
- `invalid_records = []` 与 `exclusions` 仍必须显式输出；两个预先存在且不属于六文件 patch的 controller pack应列入 exclusions，而不是 event denominator。

Gate 1 的 mandatory output fields 为 `contract_id`、`profile`、`status`、`gate`、`experiment_id`、`experiment_version`、`run_id`、`input_manifest_digest`、`evaluator_artifact_digest`、`event_range`、`denominators`、`metrics`、`invalid_records`、`exclusions`、`support_diagnostics`、`gate_checks`、`claim_ceiling` 与 `reviewer_attestation`；其值使用上面的固定 N/A/empty语义。六文件或 v1 freeze identity缺失/冲突时返回 `MANIFEST_INVALID`；明确列为 N/A 的运行期字段不触发该错误。

Gate 1 的重算顺序固定为：验证六文件路径/版本/交叉引用与 SHA-256；重算 Git/diff/approved-scope snapshot与三个 v1 frozen hash；检查 canonical gate-to-milestone mapping、claim ceiling与 forbidden-path boundary；输出静态 checks和 digest-bound candidate verdict。它不执行下节的 event/reward/OPE步骤。

## 3. Gates 2–7 重算顺序

evaluator 按以下顺序 fail closed：

1. 验证 manifest identity、schema version、event hash chain 与唯一 ordering；
2. 重建每个 decision 状态机；
3. 验证 action-before-dispatch、delivered bytes/request digest 与 exposure status；
4. 从 probability vector 重算 slot/joint/effective propensity；
5. 以 composite FK 唯一 join outcome/oracle/reward；
6. 应用 arm-blinded missing/invalid rule；
7. 重算 correctness、abstention、Brier、reliability、安全、成本与 usage；
8. 对 simulator/OPE/replay gate执行预注册阈值；
9. 输出所有 denominator、invalid/rejected/excluded项与原因；
10. 将 candidate verdict 交给独立 Reviewer，不自行晋级为 `PASS`。

## 4. 输出 schema

输出必须是 strict JSON，至少包含：

```json
{
  "contract_id": "alaya-ll-v2-evaluator/2.1.0",
  "profile": "G1_STATIC_FORMALIZATION",
  "status": "PASS|FAIL|BLOCKED|NOT_IDENTIFIED",
  "gate": 1,
  "experiment_id": "string",
  "experiment_version": "string",
  "run_id": "NOT_APPLICABLE",
  "input_manifest_digest": "sha256:<hex>",
  "evaluator_artifact_digest": "sha256:<hex>",
  "event_range": {"stream_id": "NOT_APPLICABLE", "first": 0, "last": 0, "count": 0},
  "denominators": {},
  "metrics": {},
  "invalid_records": [],
  "exclusions": [],
  "support_diagnostics": {},
  "gate_checks": [],
  "claim_ceiling": "local checks",
  "reviewer_attestation": null
}
```

- `PASS` 只能表示该 evaluator 所评 gate 的阈值通过；不能自动表示后续 gate、provider readiness 或正式验收。
- `NOT_IDENTIFIED` 用于 support/propensity/因果识别失败。
- `BLOCKED` 用于必需 artifact/权限不可用。
- 空数组和零 denominator 必须显式输出，不得省略。

## 5. Gate 1 evaluator 规则

Gate 1 不运行 product/provider代码。它对六份正式化 artifact 做静态一致性审查：

- 版本与状态字段存在；
- ADR、causal、threat、evaluator、prereg、v1 freeze 引用闭合；
- action/reward/estimand/support/interference/missingness/stop rule 无冲突；
- 明确禁止 equal-credit、post-treatment propensity、held-out leakage、approval spoof、v1 contamination；
- v1 三个 frozen artifacts hash 与 `LEARNING_LOOP_V2_V1_EVIDENCE_FREEZE.md` 完全一致，并由 evaluator独立重算；
- Git diff 不包含 product/script code；
- claim ceiling 保持为 `local checks`。

实现者提交的预期状态为 `REVIEW_READY`；独立 Reviewer 的 `PASS` 必须绑定上述六份文件的 SHA-256 集合。

## 6. 后续 gate 专属输出

- Gate 2 Experience Contract：crash-point matrix、unique join、idempotency、provider-without-action拒绝、critical mutant总数/kill数与等价 mutant独立裁定。
- Gate 3 Baseline Exposure：no-injection leakage count、static policy mutation count、proposed/delivered exposure completeness、renderer/request digest与 effective propensity重算。
- Gate 4 Simulator & Counterexamples：known optimum、regret、recovery probability、coverage、wrong-learner与 frozen counterexample rejection。
- Gate 5 Replay & OPE：production/reference derived-state byte equality、unsupported mass、ESS、weight tail、bias与 coverage against online simulator truth。
- Gate 6 Isolation & Dry Shadow：held-out/approval/credential isolation；provider authorization/start count `0`、product/credit mutation `0`、logging completeness `100%`。
- Gate 7 Offline Closeout：G1–G6 ACK identity closure、integrated manifest/diff/validation/freeze一致性，以及 E0 provider decision仍为 `UNAUTHORIZED/UNRESOLVED`。
