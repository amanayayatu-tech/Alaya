# explicit-marker + LLM Contract Fix Report

## Scope

Branch: `codex/fix-marker-llm-contract`

Base: `main @ 0b65118` (`32cd40f` plus repository hygiene removal of the old review bundle).

This change is limited to the two issues from the prompt:

1. Tighten generic explicit-marker conflict detection so unrelated knowledge is not paired as a conflict.
2. Harden the three unstable LLM prompt contracts: `generate_autonomous_goal`, `plan_cycle`, and `emit_task_spec`.

No runner, safety-mode, flywheel convergence, scheduler behavior, or A/D previously verified paths were intentionally changed. The only non-production file outside direct regression tests is an existing test fixture in `external_feedback_scheduler.test.ts`, updated because it was depending on the old false-positive generic marker behavior.

Commit hash: recorded in the final response. Embedding the exact hash inside this committed file would make the commit hash self-referential.

## Fix 1: explicit-marker Tightening

Changed file:

- `alaya-app/server/knowledgeReview.ts`

What changed:

- `sameDecisionTopic` now treats two knowledge items as related when they share a normalized key, both carry `health_signal`, share an extracted metric, or both clearly belong to the health/wearable decision domain.
- `explicitContradictionMarkers` still lets targeted markers bypass topic gating when they explicitly name the other knowledge id, including `contradicts:<id>`, `conflict_with:<id>`, and existing `contradicts_strong:<id>` / `conflict_with_strong:<id>` forms.
- Generic markers such as `needs_conflict_review`, `conflict_with_strong`, `明确冲突`, and `互相矛盾` now require `sameDecisionTopic(a, b)` before creating a conflict candidate.
- Seed/onboarding knowledge remains excluded from generic marker scanning.
- Metric, conclusion-tag, and topic-polarity conflict paths were left intact.

Regression tests:

- Added `generic contradiction marker does not pair unrelated decision topics`.
- Added `generic contradiction marker still creates a conflict within the same topic`.
- Added `targeted contradiction marker still bypasses the topic gate`.
- Updated one scheduler audit fixture so it uses a real related strong item instead of relying on an unrelated generic-marker false positive.

Red/green evidence:

- Before implementation, the new unrelated-marker regression failed: expected `0` conflict candidates, got `1`.
- Before implementation, LLM contract tests also failed because `outputContract` was absent.
- After implementation, the targeted command passed: `cd alaya-app && node --import ./node_modules/tsx/dist/esm/index.mjs --test tests/knowledgeReview.test.ts tests/llm_contracts.test.ts` -> `24/24` passing.

## Fix 2: LLM Prompt Contract Hardening

Changed files:

- `alaya-app/server/autonomousGoal.ts`
- `alaya-app/server/flywheel/core.ts`
- `alaya-app/server/llm.ts`

What changed:

- `generate_autonomous_goal` now passes a structured `outputContract` with required keys, prediction shape, rules, and a minimal valid example.
- `plan_cycle` now passes a structured `outputContract` with required keys, string prediction shape, rules, and a minimal valid example.
- `emit_task_spec` now passes a structured `outputContract` with required keys, boolean `buildSuccess`, string fields, rules, and a minimal valid example.
- Each of the three prompt calls now has explicit prohibited/instruction text requiring one JSON object, exact top-level keys, and `[]` for empty arrays.
- `BASE_SYSTEM_INSTRUCTIONS` in `llm.ts` now tells the model to use `previous_error` to fix schema/JSON issues on retry and not repeat the same invalid shape.

Validation was not weakened:

- Schema validation remains active.
- Fallback/degradation gates still exist.
- Existing bad-output tests still pass, including app/core tests that validate simplified fallback, promotion only when the original schema is satisfied, and diagnostic gates when bad output persists.

Regression tests:

- Added `llm_contracts.test.ts` with contract tests for all three prompt paths.
- The tests assert each prompt carries the expected `outputContract`, exact prompt name, required keys, "Return only one JSON object", and "empty arrays as []" instructions.

## Changed Files

Production:

- `alaya-app/server/knowledgeReview.ts`
- `alaya-app/server/autonomousGoal.ts`
- `alaya-app/server/flywheel/core.ts`
- `alaya-app/server/llm.ts`

Tests:

- `alaya-app/tests/knowledgeReview.test.ts`
- `alaya-app/tests/llm_contracts.test.ts`
- `alaya-app/tests/external_feedback_scheduler.test.ts`

Deliverable:

- `FIX_REPORT_marker_llm.md`

Ignored/uncommitted prior artifact intentionally not included:

- `SMOKE_FINDINGS_32cd40f.md`

Diff stat before adding this report:

```text
alaya-app/server/autonomousGoal.ts                 | 43 ++++++++++++-
alaya-app/server/flywheel/core.ts                  | 42 +++++++++++-
alaya-app/server/knowledgeReview.ts                |  7 +-
alaya-app/server/llm.ts                            |  3 +-
alaya-app/tests/external_feedback_scheduler.test.ts| 33 +++++++++-
alaya-app/tests/knowledgeReview.test.ts            | 75 ++++++++++++++++++++++
alaya-app/tests/llm_contracts.test.ts              | 129 new lines
```

## Validation

Logs are in:

`validation-logs/marker-llm-fix_20260610_171225`

Commands run and passed:

```bash
npm run typecheck
npm run guard
npm run test:all
npm run benchmark:smoke
npm run flywheel
npm run secret:scan
git diff --check
```

Observed results:

- `typecheck`: passed.
- `guard`: passed, 18 checks.
- `test:all`: passed (`alaya-core` 52/52, `alaya-app` 240/240, scripts 24/24).
- `benchmark:smoke`: passed 12/12.
- `flywheel`: passed 4-round mock flywheel acceptance.
- `secret:scan`: passed, no high-confidence secrets.
- `git diff --check`: passed, no whitespace errors.

## Packaging Notes

The review bundle should include this report, the final patch, changed source/test files, and the validation logs above. It must not include local secret files or previous run key files.
