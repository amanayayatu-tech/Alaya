# Alaya learning-loop v2 Gates 1–7 离线预注册

- 状态：`REVIEW_READY`
- 版本：`2.1.0`
- 2.1.0 变更：2.1.0 是新 experiment version。G4 规格阈值与 G5 统计阈值在种子生成前签署；2.0.0 清单只作历史 unblinded archive。
- experiment id：`alaya-learning-loop-v2-offline`
- experiment version：`2.1.0`
- 注册日期：2026-07-13
- 允许证据层：`local checks`

## 1. 研究问题与边界

本 prereg 只回答：v2 架构是否在不调用真实 provider、不启用 online learner、不改变产品行为的情况下，通过 Gates 1–7 的离线可测量性与 fail-closed readiness 检查。

它不回答 injection 是否提高真实模型准确率，不回答 online learning 是否有效，也不授权 E0/E1/H3、canary、24h run、formal/science/product/public claim。

## 2. 固定 hypotheses

- H-G1：六份 versioned formalization artifacts 对 intervention、estimand、contract、threat、evaluator 与 v1 freeze 的定义一致且无未决解释空间。
- H-G2：Experience contract 对 action-before-dispatch、unique reward join、ordering、idempotency、crash recovery 与 critical property/fuzz/mutation corpus 全部 fail closed。
- H-G3：strict no-injection 与 frozen-static baseline 在 proposed/delivered exposure、renderer/request digest 与 exact propensity 上可区分、可重放且无 baseline leakage。
- H-G4：deterministic simulator 能在 frozen seed ensemble 上恢复 known optimum，并拒绝 equal-credit 等故意错误 learner与 frozen counterexamples。
- H-G5：golden replay 在 production/reference implementation 间产生 byte-stable derived-state digest；OPE 有 support 时满足预注册 bias/coverage/ESS门，无 support 时返回 `OPE_NOT_IDENTIFIED`。
- H-G6：held-out、approval、credential/request boundary fail closed，且 dry shadow 到 dispatch boundary 时新增真实 provider authorization/start=0、product mutation=0、credit write=0、logging completeness=100%。
- H-G7：offline closeout 的 artifact、validation、review、roadmap与 claim boundary 完整一致，E0 provider decision保持独立且未获授权。

每个 hypothesis 只有 `PASS/FAIL/BLOCKED`；G5 另允许 `NOT_IDENTIFIED`，但该值不算 PASS。

## 3. Gate 顺序、repair 与停止规则

- 严格顺序与 canonical roadmap 一致：`G1/M0 Formalization → G2/M1 Experience Contract → G3/M2 Baseline Exposure → G4/M3 Simulator & Counterexamples → G5/M4 Replay & OPE → G6/M5 Isolation & Dry Shadow → G7/M6 Offline Closeout`。前一 Goal 的 code review、必要的 Local Verification与 Roadmap Audit未被 canonical runtime ACK，或后一 milestone尚未成为唯一 Active 时，后一 gate不开始。
- 每个 gate首次失败允许一次 bounded repair；同 experiment version 第二次失败进入 `ARCH_REVIEW_REQUIRED` 并停止。
- schema、policy contract、reward、evaluator、constraint 或本 prereg 实质变化必须升级 experiment version并回到 G1。
- 任何真实 provider request/authorization、v1 evidence import、held-out write、approval bypass、scope violation或 secret发现立即停止并标 `FAIL`。
- missing required artifact 为 `BLOCKED`，不得推断 PASS。

## 4. Gate 1 冻结输入与判据

冻结输入：

- `docs/ai/ADR_LEARNING_LOOP_V2.md`
- `docs/ai/LEARNING_LOOP_V2_CAUSAL_CONTRACT.md`
- `docs/ai/LEARNING_LOOP_V2_THREAT_MODEL.md`
- `docs/validation/LEARNING_LOOP_V2_EVALUATOR_CONTRACT.md`
- `docs/validation/EXPERIMENT_PREREG_learning_loop_v2.md`
- `docs/validation/LEARNING_LOOP_V2_V1_EVIDENCE_FREEZE.md`

PASS 必须同时满足：

1. 六份文件均为 version `2.1.0` 与 `REVIEW_READY` candidate，引用闭合且无冲突；
2. action unit、reward、estimands、positivity、interference、missingness、approval、held-out 与 stop rule 明确；
3. v1 frozen files的 SHA-256 与 freeze doc一致且工作树无改动；
4. diff 仅含上述 v2 docs，无 product/script code；
5. 独立 Reviewer 输出 digest-bound `PASS`。

实现者本 Goal 只能完成 1–4 并请求 5；不能自批。

## 5. Gates 2–7 冻结最小设计

### G2 Experience Contract

对 action transaction 前后每个边界做 deterministic crash injection。必测 missing/duplicate/late/cross-run/wrong-case/wrong-version/malformed reward、provider-without-action、same-key-same/different-digest、same-timestamp different sequence。任一 fail-open 即 FAIL。

critical corpus至少覆盖 duplicate JSON keys、Unicode whitespace、non-finite number、actor/count spoof、wrong-subject/revoked grant、held-out alias、corrupt propensity、first-failure callback/retry。critical mutants必须 100% killed；等价 mutant只能由独立 Reviewer书面裁定。

### G3 Baseline Exposure

- strict no-injection 的 provider-visible bytes 不得包含 activeKnowledge metadata、knowledge reference、summary 或等价旁路；
- frozen-static 只能使用冻结候选、score、tie-break、renderer 与 token budget，不得写 credit 或更新 policy；
- proposed 与 delivered action、empty/no-op exposure、renderer bytes、request digest 与 effective propensity必须可唯一关联；
- no-injection 与 frozen-static 在同一 context/candidate manifest 下可独立 replay；任一 baseline leakage、未记录 truncation 或 propensity 混称即 FAIL。

### G4 Simulator & Counterexamples

- worlds：additive、synergy、antagonism、redundancy、order effect、no-support、nonstationarity；
- seeds：由未来 G4 dispatch 在实现前生成并签署固定 manifest；不得在看结果后换 seed；
- 必须输出 known optimum、regret、optimum recovery probability与 interval；
- equal-credit learner 在至少 antagonism/order worlds 中必须被判错；正确 B0 learner 必须在其声明假设成立的 worlds 中达到由 G4 prereg amendment事前冻结的阈值。

2.1.0 G4 规格阈值已在种子前冻结于 `LEARNING_LOOP_V2_G4_SPEC_AMENDMENT.json`：eligible recovery 由 B0 action set 决定；equal-credit 必须在 antagonism 与 order 的每一个 seed 上判错。seed statistical pass_thresholds 仍为 null。2.0.0 的 8-seed 清单只作 unblinded archive。

### G5 Replay & OPE

固定 event pack同时输入 production与独立 reference implementation；derived state、invalid/rejected集合与digest必须 byte-equal。timestamp shuffle、PRNG/runtime drift或 event order歧义必须被检测并拒绝。

只用 simulator logged data。必须比较 IPS、SNIPS、DR、SWITCH 与 simulator online truth；报告 unsupported mass、ESS、max/quantile weights、bias与 interval coverage。2.1.0 统计门槛已在新种子前冻结于 `LEARNING_LOOP_V2_G5_OPE_AMENDMENT.json`：n=224，essMin=37（E[ESS]=n/3 的一半），maxWeight=3，DR |bias|≤1e-9，IPS/SNIPS/DR 的 overall Wald 95% 区间必须覆盖 online truth；7-world coverage 只作诊断。无 support 返回 `OPE_NOT_IDENTIFIED`。达标只构成 `REVIEW_READY`，不是独立 Reviewer PASS。2.0.0 的 ESS=18 / IPS coverage=6/7 禁止作为本版门槛。

### G6 Isolation & Dry Shadow

使用 provider stub或既存 response replay，到真实 request-building 的 dispatch boundary即止。禁止新 provider调用。PASS要求：

- provider authorization/start count `0`；
- product/injection/credit/knowledge mutation `0`；
- required action/propensity/request-digest events completeness `100%`；
- held-out read/write `0`；
- first hard failure后的 callback/retry/authorization `0`。

此外必须证明 held-out process/DB/credential与 learner无写通路，approval grant subject/version-bound且原子消费，credential broker在 Gates 1–7不签发真实 provider credential。

### G7 Offline Closeout

- G1–G6 的 Worker、CODE_REVIEW、必要 Local Verification 与 ROADMAP_AUDIT identities全部精确 ACK；
- integrated artifact manifest、diff、validation、forbidden-artifact scan 与 v1 freeze hash一致；
- final independent audit只可确认 offline architecture evidence，E0 provider decision必须保持 `UNAUTHORIZED/UNRESOLVED`；
- 不得以 closeout替代 provider、formal、science、product或 public acceptance。

## 6. Validation 与 change-impact

本 `ALAYA-V2-G0` / Gate 1 文档 Goal 固定执行：

```text
npm --prefix alaya-app run check
npm --prefix alaya-app test
npm run test:scripts
npm run guard
npm run secret:scan
npm run test:all
git diff --check
```

change-impact检查必须证明：

- changed files全部位于 `docs/ai/**` 或 `docs/validation/**`；
- v1 frozen三文件 hash不变；
- `.codex-loop/**`、provider、DB、run artifact、controller pack未被纳入产品 diff；
- branch、base/head与diff digest被报告。

## 7. Missingness、exclusion 与版本控制

- 不允许事后删除失败 seed/run；所有 invalid/rejected项进入 denominator与原因清单。
- contract-invalid artifact不得进入算法 estimand；原 artifact不可变归档。
- 只有事前列出的 reserve unit可按 arm-blinded规则补位。
- 修改 exclusion、reward、threshold、oracle、evaluator或support规则即新 experiment version。
- 当前文档中的未来 threshold amendment只能在对应 gate开始前由独立 Reviewer签署；未签署时 gate保持 `NOT_STARTED/BLOCKED`。

## 8. Claim vocabulary

允许：`Gate N local checks PASS`、`REVIEW_READY`、`NOT_IDENTIFIED`、`BLOCKED`、`FAIL`。

禁止：provider ready、online validated、formal acceptance、scientifically effective、product ready、production ready、publicly proven，以及任何把 v1 failed diagnostic当作 v2 positive evidence 的表述。
