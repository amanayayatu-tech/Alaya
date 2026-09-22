# Alaya learning-loop v1 failed-evidence freeze for v2

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：v1 三件 hash 不变。2.1.0 只升级本 freeze 文档的 v2 版本号。
- freeze purpose：保留历史身份并禁止 v1 evidence 进入 v2 claim
- 当前证据层：`local checks`

## 1. Frozen source identities

| Artifact | SHA-256 | v2 eligibility |
| --- | --- | --- |
| `docs/ai/CODEX_MISSION_learning_loop.md` | `357a467792a6b09ae650245f68830298e6fa499ab3e3a3fa86ef82ee38696484` | `INELIGIBLE` |
| `docs/validation/EXPERIMENT_PREREG_learning_loop.md` | `f55f5ed9b0ecb344913abac2b86d321cc7b2644115324e6da39af301bf5415d9` | `INELIGIBLE` |
| `docs/validation/PR_L6_LEARNING_LOOP_FAILED_CASE.md` | `87b06e7dd55f30699d445116f04c4d0f438a7b359403e55e6489fdc87735669c` | `INELIGIBLE` |

历史 anchor branch/head（仅身份）：`codex/learning-loop @ b7090b11b41f358f4d82906c86be835a68c06e64`。

本 freeze doc不修改、纠正或重新解释上述 v1 文件。v1 prereg中的 H1/H2/H3、5pp margin、旧统计脚本与旧 mission只能作为历史设计事实；failed-case report 的归档状态仍为：

> `FAILED / PAUSED / NOT FORMAL ACCEPTANCE / NOT PRODUCTION-READY`

## 2. Explicit non-eligibility

以下均不得作为 v2 train、prior、OPE、gate PASS、formal、science、product 或 public evidence：

- v1 alpha/beta、checkpoint、credit rows、ROI、reward rows与 policy state；
- v1 failed run DB/SQLite、provider response、raw bundle、usage aggregate与 `/tmp` forensic artifacts；
- PR-L1–L6 local green tests、failed compressed diagnostic、Draft PR或 CI green status；
- v1 `phase3_stats.py`/pilot输出、H1/H2/H3结论或旧 5pp business meaning；
- contaminated synthetic correctness、held-out leakage、reward mismatch与 equal-credit数据。

允许复用的只有普通代码 substrate或经人工重新审核的知识内容，并且必须在 v2 fresh ledger、fresh prior、fresh version与对应 gate中重新验证。复用代码不等于复用证据。

## 3. Immutability check

Gate 1 与每次 v2 evidence packaging 前必须：

1. 重算本表三个 SHA-256并精确匹配；
2. 确认 `git diff --` 对三个路径为空；
3. 确认任何 v2 manifest未列出 v1 DB/run/checkpoint/reward；
4. 发现 mismatch即输出 `V1_FREEZE_VIOLATION`并停止，禁止“更新 hash 以适配改动”。

## 4. Claim boundary

本文件只证明三个 tracked文档在本 Goal 开始时具有上述 byte identity，并记录它们对 v2 claim 的不合格状态。它不证明 v1 failed run的内容正确，不把历史 archive提升为正式验收，也不证明 v2 architecture已通过独立 Review。
