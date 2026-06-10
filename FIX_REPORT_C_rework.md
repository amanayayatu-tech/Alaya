# FIX_REPORT_C_rework

## Result

- Base: `55eb051` (`Fix smoke validation regressions`)
- New code commit: `a440dc0063be064bab75219193e12b245db3d91f`
- Branch: `codex/rework-c-conflict-detection`
- Scope: C product-level conflict detection rework, runner shortcut revert, and E out-of-scope API registration.
- Not run by design: the next >=3h real MiniMax retest from the prompt. This round only implements and verifies the local/product fix.

## C Product-Level Fix

Changed `alaya-app/server/knowledgeReview.ts`:

- Lines 67-75 add `knowledgeText()` so topic polarity extraction uses product evidence content, tags, semantic key, and source reference.
- Lines 211-223 define topic signal types and health-signal topic patterns for PPG, ECG, and hybrid evidence.
- Lines 243-265 add `isExternalEvidenceDraft()` and `isConflictScannableKnowledge()`.
  - Existing `active` and `strong` knowledge remains scannable.
  - Draft evidence is scannable only when it is non-superseded, non-onboarding, non-internal/non-speculative, and carries external evidence provenance such as `createdBy=human_gate`, external feedback source type, or meaning/form/business-signal tags.
  - Internal draft creators including `distiller`, `builder`, `librarian`, `scheduler`, `agent`, and `test` remain excluded from conflict scanning.
- Lines 267-341 add product topic-polarity detection.
  - Metric direction: `ppg_priority_score >= X` becomes a PPG prefer signal; `ppg_priority_score <= X` becomes a PPG avoid signal.
  - Text conclusion direction: phrases such as `优先 PPG` and `优先 ECG` become mutually exclusive preference signals under the same decision topic.
  - Onboarding seed knowledge is excluded from this topic-polarity path to preserve the D fix.
- Lines 416-425 wire this into `conflictBetween()` before generic contradiction markers.
- Line 494 changes `detectKnowledgeConflicts()` from active/strong-only scanning to `isConflictScannableKnowledge()`.

This does not depend on runner markers. The product logic does not read `sourceName === "health-signal-contradiction-runner"` or sample id patterns. `review_bundle_C_rework/logs/no-runner-shortcut-grep.log` is empty for those shortcut strings.

## Tests And Red-Green Evidence

Changed `alaya-app/tests/knowledgeReview.test.ts`:

- Lines 163-194 add a non-speculative external draft evidence regression test:
  - Strong PPG current evidence: `ppg_priority_score >= 0.7` and `优先 PPG`.
  - Draft external evidence: `ppg_priority_score <= 0.35` and `优先 ECG`.
  - Asserts conflict candidate, conflict review, and weaker external draft marked `conflict`.
- Lines 196-221 add a topic polarity regression test for `优先 PPG` vs `优先 ECG`.
- Lines 223-252 add the speculative draft isolation assertion:
  - A `draft` item from `createdBy=distiller`, tagged `speculative`, and sourced from `cycle_spec_...` is not conflict-scanned.
  - The same speculative draft is still excluded from `buildKnowledgeContext()`.
- Lines 141-161 keep the D seed false-positive regression.

Red evidence:

- `review_bundle_C_rework/logs/knowledgeReview-red-on-55eb051.log`
- Generated in a temporary worktree using `55eb051` product code plus the new tests.
- Result: 18 tests, 16 pass, 2 fail.
- Failing tests:
  - `non-speculative external draft evidence creates a topic conflict without runner markers`
  - `topic conclusion polarity detects PPG versus ECG priority conflicts`

Green evidence:

- Current focused run of `cd alaya-app && node --import tsx --test tests/knowledgeReview.test.ts`: 18/18 passed.
- Full `npm run test:all`: core 52/52, app 234/234, scripts 24/24 passed.

## Speculative Isolation Proof

The product guard is explicit:

- `isSpeculativeOrInternalDraft()` excludes drafts tagged `speculative`, drafts whose `sourceRef` contains `cycle_spec_`, and drafts created by internal/product agents.
- `isExternalEvidenceDraft()` only admits draft knowledge after that internal/speculative exclusion.
- The test `speculative draft knowledge remains isolated from conflict detection and injection` proves both sides:
  - `detectKnowledgeConflicts()` returns zero for a speculative ECG draft that contradicts active PPG knowledge.
  - `buildKnowledgeContext()` does not inject that draft.

`knowledgeInjection.ts` was not changed; it still injects only `active` and `strong` unsuperseded knowledge.

## Runner Shortcut Reverted

Changed `scripts/health-signal-36h-validation.mjs`:

- Removed `isRunnerInjectedContradictionGate()`.
- Restored `shouldHoldMeaningGate()` so any meaning gate matching `meaningGateRequiresHumanReview()` is held, including runner-injected contradiction gates.
- Removed the runner-specific rationale branch that said runner-injected contradiction evidence was being approved to materialize product conflict review.

The remaining runner changes from `55eb051` are retained only where they are client-side robustness:

- `responseItems()` handles both arrays and `{ items }`.
- `collectMetrics()` uses `summary=true` for human gates and knowledge but still normalizes the response through `responseItems()`.
- `STARTUP_FINDINGS` keeps the generic-stimulus P2 without re-adding monitor contract false positives.

Runner revert diff is in `review_bundle_C_rework/diffs/runner_revert.diff`.

## E Out-Of-Scope Change Registration

The `?summary=true` API support was introduced in `55eb051`, not in this C rework commit. It is retained and registered here because it makes validation sampling more stable and is backward-compatible.

Product API behavior:

- `/api/human-gates?...&summary=true` returns `{ items, total, pendingCount }`.
- `/api/human-gates` without `summary=true` still returns the legacy array.
- `/api/knowledge?...&summary=true` returns `{ items, total }`.
- `/api/knowledge` without `summary=true` still returns the legacy array.

Coverage:

- `alaya-app/tests/flywheelHealth.api.test.ts` covers legacy filtered arrays and summary object responses for both endpoints.
- `npm run test:all` passed with this behavior retained.

## Diff Stat

```text
 alaya-app/server/knowledgeReview.ts      | 137 ++++++++++++++++++++++++++++++-
 alaya-app/tests/knowledgeReview.test.ts  |  93 ++++++++++++++++++++-
 scripts/health-signal-36h-validation.mjs |  16 +---
 3 files changed, 228 insertions(+), 18 deletions(-)
```

## Verification

All outputs are included under `review_bundle_C_rework/logs/`.

```text
npm run typecheck         PASS
npm run guard             PASS
npm run test:all          PASS (core 52/52, app 234/234, scripts 24/24)
npm run benchmark:smoke   PASS (12/12)
npm run flywheel          PASS
npm run secret:scan       PASS
git diff --check          PASS
```

No high-confidence secrets were found by `npm run secret:scan`.

## Review Bundle Contents

The generated archive `REVIEW_BUNDLE_C_rework.tar.gz` contains:

- `FIX_REPORT_C_rework.md`
- `diffs/diff_55eb051_to_HEAD.patch`
- `diffs/diffstat_55eb051_to_HEAD.txt`
- `diffs/knowledgeReview.diff`
- `diffs/knowledgeReview_test.diff`
- `diffs/runner_revert.diff`
- `files/knowledgeReview.ts`
- `files/knowledgeReview.test.ts`
- `files/health-signal-36h-validation.mjs`
- all verification logs under `logs/`
