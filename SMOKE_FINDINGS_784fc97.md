# SMOKE_FINDINGS_784fc97

## Verdict

**Result: partial / not a clean pass.**

The real MiniMax smoke on commit `784fc97` completed for more than 1 hour with real provider calls, no runner crash, no `sample_failed`, and no LLM fallback. However, it exposed P1 product/validation issues that block claiming the stronger 1h smoke acceptance:

- speculative drafting re-entry produced `UNIQUE constraint failed: tasks.id`;
- one speculative cycle later closed while still carrying `draft_status=drafting`;
- conflict lifecycle did not meet the requested threshold despite 13 contradiction injections;
- human-gate backlog grew instead of dropping and triggered attention-overload throttling;
- Telegram digest delivery was not exercised because external notifications were disabled for this smoke.

## Run Facts

- Baseline: `784fc97` (`Harden review window approvals`), detached HEAD.
- Product-code freeze: no product source edits were made during the smoke.
- Run dir: `validation-logs/health-signal-1h_784fc97_20260610_094828`
- DB: `validation-logs/health-signal-1h_784fc97_20260610_094828/health-signal.db`
- Provider: `ALAYA_LLM_PROVIDER=openai`
- OpenAI-compatible base URL: `https://api.minimax.io/openai`
- Model: `MiniMax-M3`
- Thinking: `MINIMAX_THINKING=disabled`
- Mode: `ALAYA_MODE=shadow`
- Scheduler/demo pollution guards: `ALAYA_SCHEDULER=false`, `ALAYA_AUTO_SEED_DEMO=false`
- Review window: `2026-06-10 09:53-10:43 Asia/Shanghai`
- Runner start/end: `2026-06-10T01:50:53.546Z` to `2026-06-10T02:53:51.876Z`
- Process duration: `3,778,330 ms` (`62m58s`)
- Samples: `13`
- Secret scan after run: passed.

## Preflight

Passed before the smoke:

- `npm install`
- `npm --prefix alaya-core install`
- `npm --prefix alaya-app install`
- `npm run typecheck`
- `npm run guard`
- `npm run test:all`
- `npm run benchmark:smoke`
- `npm run flywheel`
- `npm run ops:migrate`
- launch guard `scripts/health-signal-36h-validation.mjs --check-only`
- empty fresh run DB before project creation

## Final Metrics

| Metric | Result |
|---|---:|
| Samples observed | 13 |
| Final `cyclesTotal` | 24 |
| Final `cyclesClosed` | 24 |
| First to final knowledge delta | 1 -> 22 |
| Knowledge count | 6 -> 27 |
| Pending gates | 0 -> 4 |
| Total gates | 6 -> 46 |
| Stall guard count | 1 |
| LLM calls | 201 |
| Provider calls | 201 |
| Non-provider calls | 0 |
| LLM failures | 0 |
| Estimated cost | `$0.94406` |
| `sample_failed` | 0 |

## Summary Criteria

| Criterion | Observed | Pass |
|---|---:|---|
| Delta reached 8 | final delta `22` | yes |
| Active knowledge never zero | min active `1` | yes |
| Provider token source at least 95% | `200/200` in runner summary | yes |
| Semantic contradiction bypass zero | `0` | yes |
| Conflict count at least 5 | max conflict count `2` | no |
| Resolved conflict reviews at least 3 | `2` | no |
| Human gate pending drop at least 30% | early avg `0.667`, late avg `4` | no |
| Stall guard under 5% | `1/24 = 4.17%` | yes |
| Sample failed zero | `0` | yes |

## Human Review And Apply Paths

- Review session opened inside the configured window: `review_proj_mq7evycb_2026_06_10_09_53_10_43`.
- Review session closed at `2026-06-10T02:45:57.691Z`.
- Session counts: `gates_total=2`, `gates_resolved=2`, `gates_deferred=0`.
- Telegram digest was not exercised in this run: `notification_digests` had no rows because `ALAYA_CAP_EXTERNAL_NOTIFICATION=false`.
- Reject path covered: `gate_ext_fb_form_7evycb_health_signal_contradiction_runner_sample_0002_ecg_support` rejected with `reasonCode=weak_evidence`.
- Defer path covered: `gate_ext_fb_form_7evycb_codex_smoke_manual_review_manual_defer_20260610020050` deferred until `2026-06-10T04:00:53.215Z`.
- Speculative revoke/apply covered:
  - `cycle_spec_6_proj_mq7evycb_cycle_5_vycb` was created as a speculative child.
  - `gate_spec_apply_pec_6_proj_mq7evycb_cycle_5_vycb` was approved, revoked during grace, then approved again.
  - Apply executor marked it `applied_observing` at `2026-06-10T02:03:57.689Z`.
  - Trace evidence exists for `speculative_draft_ready`, `speculative_apply_revoked`, and `speculative_apply_marked`.
- Unauthorized callback post-run check covered:
  - `CallbackRouter` rejected user `999` while `ALAYA_TELEGRAM_USER_ID=12345`.
  - `event_log` recorded `telegram_unauthorized_callback`.
  - `trace_events` recorded `telegram_unauthorized_callback` with status `blocked`.

## Findings

### P1: Speculative Draft Re-entry Is Not Idempotent

At `2026-06-10T02:06:54.266Z`, the runner recorded:

`POST /api/projects/proj_mq7evycb/scheduler/tick failed: 500 {"message":"UNIQUE constraint failed: tasks.id"}`

The runner retried and continued, but this is a real scheduler correctness issue. Later DB state showed:

- `cycle_spec_6_proj_mq7evycb_cycle_5_vycb`: `closed`, `draft_status=applied_observing`
- `cycle_spec_7_proj_mq7evycb_cycle_5_vycb`: `closed`, `draft_status=drafting`

A closed speculative cycle should not retain `drafting`, and speculative builder task creation needs idempotent handling under retry/re-entry.

### P1: Conflict Lifecycle Did Not Meet Acceptance Threshold

The run injected 13 contradiction feedback items:

- `ppg_support`: 3
- `ecg_support`: 2
- `ppg_risk`: 2
- `ecg_risk`: 2
- `hybrid_support`: 2
- `hybrid_reject`: 2

But conflict lifecycle summary showed:

- conflict scans: 79
- conflict candidate total: 0
- review required total: 2
- resolved unique reviews: 2
- max snapshot conflict count: 1

This fails the requested conflict depth. The only explicit P1 issue captured by the runner was also a false positive on onboarding seed records, not a robust lifecycle over the injected PPG/ECG evidence.

### P1: Human Gate Backlog Did Not Converge

Human gate backlog increased:

- early pending average: `0.667`
- late pending average: `4`
- pending drop ratio: `-5.0`

The run eventually triggered `human_attention_overload` and `safety_throttled` at cycle 20. This is not a crash, but it means the run does not prove gate convergence for unattended operation.

### P1: Monitor Contract In The Prompt Does Not Match Current API

The runner recorded two monitor contract mismatches:

- `/api/human-gates` returns an array, not `{ pendingCount }`
- `/api/knowledge` returns an array, not `{ total }`

The validation runner computed these metrics client-side, so the smoke could continue, but the prompt-level jq expressions are not valid against commit `784fc97`.

### P1: Seed Conflict False Positive

The conflict detector marked onboarding seed records as conflicting because the project brief intentionally contained words like `明确冲突` / `互相矛盾`. This generated `kr_7447dce0` before substantive PPG/ECG evidence existed.

### P2: Domain Stimulus Is Partly Generic

The first four built-in flywheel stimuli still include generic high-risk automation/product scenarios. The onboarding prompt and injected form feedback are health-signal-specific, but the cycle content is not fully domain-pure.

### P2: Telegram Digest Was Not Exercised

The review window session opened and closed, and API/callback paths were exercised. Actual digest/summary message delivery was not tested because this smoke intentionally ran with `ALAYA_CAP_EXTERNAL_NOTIFICATION=false`.

## Positive Evidence

- Real MiniMax provider canary succeeded with `provider=openai`, `model=MiniMax-M3`.
- All recorded LLM calls used provider tokens: `201/201`.
- No LLM failures were recorded.
- No sample failed.
- The flywheel advanced from cycle 1 to cycle 24 and closed all 24 observed cycles.
- Speculative approve -> revoke -> reapprove -> apply was exercised through product services.
- Unauthorized callback guard was verified post-run and recorded both event and trace evidence.
- Secret scan passed after the run.

## Follow-up Fixes

Branch `codex/fix-784fc97-smoke-findings` addresses the actionable P1s found in this smoke:

- Speculative draft creation now ignores closed children, uses collision-resistant builder task IDs, and completes half-created drafting children transactionally before returning them.
- Onboarding seed knowledge no longer triggers conflict reviews from generic task wording such as `明确冲突` or `互相矛盾`; explicit targeted markers still work.
- The health-signal runner now samples the current summary API shapes for human gates and knowledge, and allows runner-injected contradiction meaning gates to materialize product conflict reviews while preserving human holds for non-runner explicit contradictions.

Verification after the fixes:

- `node --import tsx --test tests/speculative_execution.test.ts tests/knowledgeReview.test.ts tests/flywheelHealth.api.test.ts` from `alaya-app`: 27/27 passed.
- `npm run typecheck`: passed.
- `npm run guard`: passed.
- `npm --prefix alaya-app test`: 231/231 passed.
- `npm run test:scripts`: 24/24 passed.
- `npm run test:all`: core 52/52, app 231/231, scripts 24/24 passed.
- `npm run benchmark:smoke`: 12/12 passed.
- `npm run flywheel`: passed.

## Evidence Files

- `validation-logs/health-signal-1h_784fc97_20260610_094828/summary.json`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/monitor_log.csv`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/events.jsonl`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/issues.md`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/timeseries_summary.json`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/conflict_lifecycle_summary.json`
- `validation-logs/health-signal-1h_784fc97_20260610_094828/provider-canary.json`
