# PR-L6 Learning Loop Failed Case

> **FAILED / PAUSED / NOT FORMAL ACCEPTANCE / NOT PRODUCTION-READY**

本文件是审计归档，不是发布说明、能力声明或继续实验的授权。PR-L6 已按 `ARCHIVE_AS_AUDITABLE_FAILED_CASE` 处置；已知 blocker 未关闭，Draft PR 不得合并。

## Record identity

| Field | Value |
| --- | --- |
| Closeout goal | `PR-L6-FAILED-CASE-CLOSEOUT-001` |
| Dispatch | `dispatch-pr-l6-failed-case-closeout-001-001` |
| Repository | `/Users/peachy/Documents/alaya` |
| Branch / HEAD at closeout | `codex/learning-loop` / `93e44ef31c9ebe5e689d364df667652e023c9708` |
| Mission contract | `docs/ai/CODEX_MISSION_learning_loop.md` |
| Frozen preregistration | `docs/validation/EXPERIMENT_PREREG_learning_loop.md` |
| Disposition | `PR-L6_PAUSED_ARCHIVED_FAILED_CASE` / `ARCHIVE_AS_AUDITABLE_FAILED_CASE` |
| Evidence ceiling | Local checks plus failed compressed diagnostic smoke/precheck only |
| Formal/public status | No 24h acceptance; no science, public, learning-effectiveness, or product-capability conclusion |

The branch HEAD identifies the committed PR-L0/PR-L1 base. PR-L2 through PR-L6 work remains an unstaged shared-worktree diff at this closeout and is not represented by that commit hash alone.

## Scope and frozen contracts

The mission attempted to connect deterministic learning cases, decision-outcome credit, Thompson-ranked retrieval, epsilon exploration, learning metrics, and a paired baseline/treatment harness. The experiment contract was frozen before implementation and was not changed by this closeout:

- World seed `2026070901`; at least 120 identically ordered cases per arm with the frozen 80/20 train/held-out split.
- Baseline: `ALAYA_KNOWLEDGE_INJECTION=off`, with disabled-injection trace evidence.
- Treatment: injection on/full, Thompson ranking, and `ALAYA_INJECTION_EPSILON=0.1`.
- `MINIMAX_THINKING=disabled` and the same provider/model route for both arms; separate DB, port, and log directory per arm.
- Runtime decisions must originate from the actual model/prediction/API/event/trace path. Harness-authored correctness is not evidence.
- Held-out cases are evaluation-only and must not mutate retrieval telemetry, knowledge evidence/lifecycle, credit, or ROI/training state.
- Compressed diagnostics may exclude only `durationAtLeast24h` and `metricsSnapshotsAtLeast48`; all other frozen gates remain blocking.
- H1/H2/H3, thresholds, scorer truth, metrics, case order, and `analysis/phase3_stats.py` decision logic remain as preregistered.

## Chronological audit timeline

| Phase | Worker / Reviewer outcome | Durable interpretation |
| --- | --- | --- |
| PR-L0 | `REVIEW_PASS` | Mission archive and preregistration were committed with a two-commit non-self-referential content anchor. Local documentation evidence only. |
| PR-L1 | `VALIDATION_BLOCKED` / `REVIEW_PASS_WITH_BLOCKED_VALIDATION` | Generator contract passed local checks; app tests and full-chain smoke were initially blocked. |
| PR-L1-VR1 | `READY_FOR_REVIEW` / `REVIEW_PASS` | Two app-test blockers were repaired; only local fixture/analyzer-contract smoke was available. |
| PR-L1-COMMIT | `READY_FOR_REVIEW` / `REVIEW_PASS` | PR-L1 and validation repairs were committed locally through `93e44ef3`; no push occurred in that goal. |
| PR-L2 | `READY_FOR_REVIEW` / `REVIEW_NEEDS_REPAIR` | Outcome credit worked locally, but idempotency depended on a latest-500 event window. |
| PR-L2-VR1 | `READY_FOR_REVIEW` / `REVIEW_PASS` | Durable specific credit lookup and a greater-than-500-events regression were accepted. PR-L2 remained uncommitted. |
| PR-L3 | `READY_FOR_REVIEW` / `REVIEW_PASS` | Seeded Thompson ranking and static fallback passed local review. |
| PR-L4 | `READY_FOR_REVIEW` / `REVIEW_PASS_WITH_BLOCKED_VALIDATION` | Epsilon exploration and ROI helper passed local review; runtime smoke was unavailable. |
| PR-L5 | `READY_FOR_REVIEW` / `REVIEW_PASS_WITH_BLOCKED_VALIDATION` | Learning metrics passed local review; analyzer smoke remained unavailable. |
| PR-L6 | `VALIDATION_BLOCKED` / `REVIEW_NEEDS_REPAIR` | Initial paired harness did not route generated cases through a valid runtime learning-evidence path. |
| PR-L6-VR1 | `VALIDATION_BLOCKED` / `REVIEW_NEEDS_REPAIR` | Two-arm analyzer completion improved, but synthetic harness correctness and non-duration gate failures remained. |
| PR-L6-VR2 | `READY_FOR_REVIEW` / `REVIEW_PASS_WITH_BLOCKED_VALIDATION` | Synthetic correctness was removed and runtime provenance wiring was accepted locally; provider diagnostic remained blocked pending rerun. |
| PRECHECK1 invalid attempt | `INVALID_BRANCH_DRIFT` | `Qpsutw` ran after branch drift to `main`; it is permanently excluded from all evidence. |
| PRECHECK1 valid retry | `VALIDATION_BLOCKED` / `REVIEW_NEEDS_REPAIR` | `kbVf4l` was a validly anchored but failed compressed diagnostic, never acceptance. |
| PR-L6-VR3 | `READY_FOR_REVIEW` / `REVIEW_NEEDS_REPAIR` | Causal binding, isolation, parsing, draining, and gate evaluation were repaired locally, but independent counterexamples remained; disposition was `NEEDS_REPAIR_ESCALATED` and the automatic repair budget reached 3/3. |
| Architecture Repair 001 | `READY_FOR_REVIEW` / `REVIEW_NEEDS_REPAIR` | Four manual architecture contracts received broad local coverage, but fail-open counterexamples remained. |
| Architecture Repair 002 | `READY_FOR_REVIEW` / `REVIEW_NEEDS_REPAIR` | Identity, analyzer binding, and required-agent inventory improved; strict parser still accepted invalid Unicode whitespace. |
| Architecture Repair 003 | `READY_FOR_REVIEW` / `REVIEW_PASS` | Strict duplicate-aware, native-JSON-bound parser passed local adversarial review. No provider run was authorized by this review. |
| PRECHECK2 | `VALIDATION_BLOCKED` / `REVIEW_NEEDS_REPAIR` | Fresh real-provider compressed diagnostic `ktXjRd` failed after incomplete case execution and non-duration gate failures. |
| PRECHECK2 Repair 001 | `READY_FOR_REVIEW` / `REVIEW_NEEDS_REPAIR` | Zero-candidate trace and latched hard-stop repairs passed local review; two governance counterexamples remained. |
| Governance Repair 002 | Interrupted during read-only preflight; no Worker final or review result | Closeout terminated and superseded this goal before implementation. It produced no code, test, runtime, or review evidence. |
| Failed-case closeout | Documentation pending review | Further repair, testing, provider execution, PRECHECK3, and RUN-L7 are frozen. |

Interrupted read-only turns and state reconciliation messages are control-plane history only. They are not implementation or validation evidence.

## Diagnostic run identities

### Immutable failed diagnostic

`/tmp/alaya-pr-l6-precheck2.ktXjRd`

- Classification: failed compressed diagnostic smoke/precheck only.
- Mode: `0700`.
- File count: `50`.
- Total bytes: `17,280,866`.
- Aggregate SHA-256: `2256e542c84ad52c838791faf17555adc9fc6654a5f7b778536d75e66d2981f8`.
- It is external to Git and must not be copied, edited, deleted, rerun, or reinterpreted as acceptance.

### Other run identities

- `/tmp/alaya-pr-l6-vr2-precheck1-final.kbVf4l`: older failed compressed diagnostic; valid branch identity, but failed gates and never constituted acceptance.
- `/tmp/alaya-pr-l6-vr2-precheck1-final.Qpsutw`: `INVALID_BRANCH_DRIFT`; permanently excluded from Reviewer evidence and every gate conclusion.

No raw provider output, credential, run environment, SQLite file, or secret is reproduced in this report.

## Historical local checks

The following counts were durable and Reviewer-verified at the cited phase. They establish only that specific local suites passed at that time; they do not override independent counterexamples or failed runtime gates.

| Phase | Historical local evidence |
| --- | --- |
| PR-L1-COMMIT | Generator `7/7`; app `266/266`; scripts `72/72`; core `71/71`; generated 120 cases (`96` train, `24` held-out), oracle `120/120`. |
| PR-L2-VR1 | Credit tests `7/7`; app `273/273`; lifecycle regression passed. |
| PR-L3 | Thompson-focused `6/6`; injection regression `5/5`; app `279/279`; scripts `72/72`. |
| PR-L4 | Epsilon `4/4`; ROI `2/2`; app `283/283`; scripts `74/74`. |
| PR-L5 | Learning metrics passed; app `283/283`; scripts `79/79`. |
| Architecture Repair 003 | Node `20.20.2` targeted parser `14/14`; broad suites on Node `22.22.1`: scripts `117/117`, app `294/294`, total `482/482`. |
| PRECHECK2 Repair 001 | Injection `17/17`, governance `10/10`, hard-stop `1/1`, dual-arm `13/13`; app `295/295`, scripts `122/122`, core `71/71`, total `488/488`. Reviewer independently reproduced two governance defects absent from those tests. |

These are local checks, not a 3h pass, not a 24h formal run, and not evidence that the learning loop improves decisions.

## Failed diagnostic gates and limitations

PRECHECK2 generated an identical 120-case oracle/case sequence for both arms, but execution stopped far short of a valid paired result:

- Baseline resolved `6`, scored `4`, held-out scored `0`; treatment resolved `1`, scored `0`, held-out scored `0`.
- Both analyzers completed with exit code `1` and the 36-check compressed contract; only the two frozen duration checks were excluded, but run binding still failed.
- Natural summary assessment and finalDrain completion were absent; three strict parse failures remained unscored.
- Usage DB evidence recorded 78 baseline calls / 118,502 tokens and 39 treatment calls / 71,595 tokens across all five expected agents on `openai/MiniMax-M3`, with provider token source. The run-bound provider/usage gate nevertheless failed and cannot be waived by those aggregate counts.
- Train/held-out minimum coverage, complete paired resolution, parse-zero, causal trace binding, watchdog/finalDrain, governance, drill-down, and learning-metric gates were not jointly satisfied.
- Knowledge ROI did not have valid paired support. `LOW_COVERAGE` must remain `LOW_COVERAGE`; no point estimate or effectiveness claim is permitted.
- Conflict-gate applicability was not converted into formal acceptance. A compressed scenario classification cannot silently remove a frozen non-duration gate.

The immediate zero-candidate trace omission and missing hard-stop latch were repaired later with local checks, but no authorized provider diagnostic verified those repairs. The governance defects below remained independently reproducible.

## Final known blockers

1. **Canonical injection-time ordering remained unresolved.** Governance evaluation did not yet prove a unique same-run/same-DB `trace_events` audit row and use its `event_log.id` as the only as-of-injection boundary. A later same-cycle supersede could still be applied retroactively.
2. **Canonical human-approval provenance remained unresolved.** A post-transition `humanApprovedCount` could still be mistaken for an independent, prior, subject-bound human approval grant. Promotion could therefore pass fail-open counterexamples.
3. **Governance Repair 002 produced no evidence.** It was terminated during interrupted read-only preflight by this closeout. No implementation, test, Worker final, Reviewer result, or runtime evidence exists for that repair.

## Repaired local-only behavior to preserve

Future work should preserve these reviewed local behaviors while treating them as unverified by a successful compressed or formal run:

- Duplicate-aware strict structured decision parser with full-text native `JSON.parse`, lexeme-aware confidence bounds, exact action sentinel, and no free-text/bare-label scoring fallback.
- Bindable zero-candidate injection trace that leaves knowledge, usage telemetry, lifecycle, credit, and inject-audit state unchanged.
- Latched first-failure hard stop that blocks retries and later provider callbacks while preserving cleanup and analyzer artifacts.
- Call-scoped held-out retrieval identity, side-effect-free held-out retrieval, causal case/cycle/prediction binding, prompt metadata removal, queue-drain fail-closed behavior, and train-only ROI filtering.
- Explicit compressed analyzer invocation/run/artifact binding and immutable all-agent inventory covering orchestrator, sensor, builder, distiller, and librarian.
- Seeded Thompson/static ranking, epsilon exploration, durable credit idempotency, and low-coverage metric suppression.

## Explicit non-results

- `PRECHECK3=0`; no PRECHECK3 dispatch or run occurred.
- `RUN-L7=0`; no 24h formal learning-loop run occurred.
- No PR-L8, deployment, merge, release, or production acceptance occurred.
- No learning-effectiveness, causal-learning, science, public, or product-capability conclusion exists.
- The failed diagnostics do not supersede the separate historical 24h cognition baseline described elsewhere in the repository; they address a different experimental learning-loop mission.

## Evidence ladder

1. **Local checks:** multiple focused and broad suites passed, subject to the independent counterexamples recorded above.
2. **Smoke/precheck:** `kbVf4l` and `ktXjRd` are failed compressed diagnostics; `Qpsutw` is invalid and excluded.
3. **Long-run/formal acceptance:** none for this learning-loop mission.
4. **Science/public/product claim:** none authorized or supported.

## Ownership and packaging manifest

This is an ownership recommendation for a future Reviewer-gated Draft PR. It is not staging or packaging authorization.

### Already committed branch-owned files

These files are attributable to PR-L0/PR-L1 and already exist in commits `64fe8a52`, `65765242`, `18d68def`, `488e6b95`, or `93e44ef3`:

- `.gitignore`
- `docs/ai/CODEX_MISSION_learning_loop.md`
- `docs/validation/EXPERIMENT_PREREG_learning_loop.md`
- `scripts/lib/learning-scenario-domain.json`
- `scripts/lib/learning-scenario-generator.mjs`
- `scripts/tests/learning-scenario-generator.test.mjs`
- `alaya-app/server/sensorFirewall.ts`
- `alaya-app/tests/evolution_engine.test.ts`

### Baseline shared-worktree manifest at closeout

All 28 entries below predate the closeout edits and were preserved without reset, stash, checkout, cleanup, staging, or implementation changes.

| Status | Path | Supported attribution | Later packaging disposition |
| --- | --- | --- | --- |
| `M` | `alaya-app/server/flywheel/core.ts` | PR-L2 credit resolve hook | Include |
| `M` | `alaya-app/server/knowledgeInjection.ts` | PR-L3/PR-L4/PR-L6 and reviewed repairs | Include, with known blockers disclosed |
| `M` | `alaya-app/server/routes.ts` | PR-L6 Architecture Repair 002 retrieval identity propagation | Include |
| `M` | `alaya-app/server/scheduler/core.ts` | PR-L6 Architecture Repair 002 call-scoped retrieval identity | Include |
| `M` | `alaya-app/server/scheduler/types.ts` | PR-L6 Architecture Repair 002 identity type plumbing | Include |
| `M` | `alaya-app/server/storage.ts` | PR-L2-VR1 durable credit lookup | Include |
| `M` | `alaya-app/tests/knowledgeInjection.test.ts` | PR-L6 architecture/zero-candidate retrieval regressions | Include |
| `M` | `analysis/extract_phase3_metrics.py` | PR-L6 learning-metric extraction | Include |
| `M` | `scripts/health-signal-36h-validation.mjs` | PR-L6 runtime-case path and hard-stop wiring | Include, with known blockers disclosed |
| `M` | `scripts/lib/health-signal-quality.mjs` | PR-L5 learning metrics | Include |
| `M` | `scripts/shadow-analyze.mjs` | PR-L5/PR-L6 metric and compressed-analyzer integration | Include |
| `M` | `scripts/tests/shadow-analyze.test.mjs` | PR-L6 compressed-analyzer regressions | Include |
| `??` | `alaya-app/server/knowledgeCredit.ts` | PR-L2 credit assignment | Include |
| `??` | `alaya-app/tests/knowledgeCredit.test.ts` | PR-L2/VR1 credit and durable-idempotency regressions | Include |
| `??` | `alaya-app/tests/knowledgeInjection.epsilon.test.ts` | PR-L4 epsilon exploration | Include |
| `??` | `alaya-app/tests/knowledgeInjection.thompson.test.ts` | PR-L3 Thompson ranking | Include |
| `??` | `alaya-learning-loop-codex-controller-pack.md` | External controller artifact; not implementation ownership | **Exclude** |
| `??` | `scripts/lib/dual-arm-harness.mjs` | PR-L6 paired harness and analyzer binding | Include, with failed-case status |
| `??` | `scripts/lib/knowledge-roi.mjs` | PR-L4 ROI helper | Include |
| `??` | `scripts/lib/learning-case-hard-stop.mjs` | PRECHECK2 Repair 001 local hard-stop repair | Include |
| `??` | `scripts/lib/learning-precheck-gates.mjs` | PR-L6 gate evaluator; contains unresolved governance contracts | Include only in failed-case Draft PR, blocker remains explicit |
| `??` | `scripts/lib/learning-runtime-contract.mjs` | PR-L6 runtime contract and Architecture Repair 003 parser | Include |
| `??` | `scripts/tests/dual-arm-harness.test.mjs` | PR-L6 paired/runtime/hard-stop regressions | Include |
| `??` | `scripts/tests/knowledge-roi.test.mjs` | PR-L4 ROI tests | Include |
| `??` | `scripts/tests/learning-case-hard-stop.test.mjs` | PRECHECK2 Repair 001 hard-stop test | Include |
| `??` | `scripts/tests/learning-metrics.test.mjs` | PR-L5 learning metric tests | Include |
| `??` | `scripts/tests/learning-precheck-gates.test.mjs` | PR-L6 gate tests; missing the unresolved governance contracts | Include only in failed-case Draft PR, test gap remains explicit |
| `??` | `scripts/tests/learning-runtime-contract.test.mjs` | PR-L6 runtime/parser adversarial tests | Include |

### Closeout-owned files

- `README.md`
- `docs/validation/PR_L6_LEARNING_LOOP_FAILED_CASE.md`

These two files are attributable only to `PR-L6-FAILED-CASE-CLOSEOUT-001` and may be considered for exact-file packaging only after Reviewer approval.

## Exact exclusion manifest

The following must not be staged, committed, bundled, or cited as successful acceptance evidence:

- `.codex-loop/**`, including `LOOP_STATE.md`, `LOOP_EVENTS.jsonl`, and `TRIAGE.md`.
- `alaya-learning-loop-codex-controller-pack.md` unless a future goal independently proves and authorizes repository ownership; current default is exclusion.
- `validation-logs/**` and every `/tmp` run directory, including `ktXjRd`, `kbVf4l`, and `Qpsutw`.
- `run-env*`, API keys, secrets, credential files, DB/SQLite files, raw provider inputs/outputs, and usage raw artifacts.
- `REVIEW_BUNDLE*`, `SMOKE_FINDINGS*`, `FIX_REPORT*`, `*.tar.gz`, and `*.bundle` artifacts.
- Any unrelated dirty file or hunk not explicitly listed in the supported ownership manifest.
- Any imagined output from Governance Repair 002; the terminated goal produced none.

Historical artifacts with these names may already exist elsewhere in the repository. This closeout neither modifies nor reattributes them; they remain outside this goal and outside the recommended exact-file stage set.

## Recovery prerequisites

Resumption requires all of the following as new, explicit work rather than continuation of the exhausted repair loop:

1. A new architecture/contract decision for canonical injection ordering using uniquely bound same-run/same-DB audit identity.
2. A new architecture/contract decision for canonical, prior, subject-bound human-approval provenance and transactional promotion.
3. Explicit authorization for any new implementation and separately for any provider/PRECHECK execution.
4. A clean independent Reviewer gate against adversarial counterexamples.
5. Frozen branch/commit/run identity and auditable per-call usage metadata.
6. A separately authorized 24h formal run satisfying every frozen gate.
7. Separate human approval for any product, science, public, or learning-effectiveness wording.

## Merge blocker

**A Draft PR containing this work must not merge while the known governance blockers remain, or without a future architecture decision and a separate acceptance plan.** Passing local suites, opening a Draft PR, or preserving failed run artifacts does not remove this blocker.
