# 2026-06-05/06 12h Real LLM Validation Report

## Verdict

The 12-hour validation passed for the core flywheel design covered by `npm run e2e:llm-flywheel`.

The run supports the stage-gate conclusion that Alaya's core cognitive flywheel can keep iterating under real LLM calls: every live pass completed 4 cycles, 20 model calls, PRD 17.3 checks, and cycle-4 compounding checks. Knowledge was reused to change later decisions, rejected directions were not repeated, prediction errors were routed back into the world-model/distiller path, and cycle 4 produced a rollback/audit-oriented principle.

Scope boundary: this was not a full `npm run e2e:live` or GitHub issue sensor business-chain validation. The runner verified GitHub API connectivity before live steps, but it did not create or sync GitHub issues.

## Run Configuration

```bash
ALAYA_VALIDATION_DURATION_SECONDS=43200 \
ALAYA_VALIDATION_SLEEP_SECONDS=600 \
ALAYA_VALIDATION_MAX_ROUNDS=72 \
bash scripts/12h_validation.sh
```

Environment facts:

| Item | Value |
| --- | --- |
| Workspace | repository checkout root |
| Start | 2026-06-05 17:53:53 CST |
| Last round start | 2026-06-06 05:46:08 CST |
| Process completed | 2026-06-06 05:57:32 CST |
| Wall-clock duration | 12h 03m 39s |
| Runner duration limit | 43,200 seconds |
| Runner max rounds | 72 |
| Actual rounds | 69 |
| Stop reason | 12-hour duration gate reached before the 72-round cap |
| Live schedule | Every third round |
| Live command | `npm run e2e:llm-flywheel` |
| LLM base/model | OpenAI-compatible MiniMax endpoint, `MiniMax-M3` |
| Summary path | `validation-logs/12h_20260605_175353/SUMMARY.csv` |
| Alerts path | `validation-logs/12h_20260605_175353/alerts.log` |
| Launch log | `validation-logs/12h_validation_20260605_175353.log` |

Local runtime logs are excluded from Git through `.git/info/exclude`; this report records the stable evidence needed by the repository.

## Aggregate Results

Machine summary:

```json
{
  "totalRounds": 69,
  "errors": 0,
  "firstDeltaPositiveRound": null,
  "lastRound": 69,
  "lastTimestamp": "05:46:08",
  "lastDelta": "NA",
  "statusCounts": {
    "guard": {
      "PASS": 69
    },
    "sim": {
      "PASS": 69
    },
    "live": {
      "SKIP": 46,
      "PASS": 23
    }
  }
}
```

Runner completion line:

```text
Completed | rounds=69 noncritical_errors=0 | summary: ./validation-logs/12h_20260605_175353/SUMMARY.csv | alerts: ./validation-logs/12h_20260605_175353/alerts.log
```

Result counts:

| Check | Result |
| --- | --- |
| Principles guard | 69/69 PASS |
| Mock flywheel simulation | 69/69 PASS |
| Real LLM flywheel | 23/23 PASS |
| Planned live skips | 46 |
| Alerts | 0 |
| Residual `screen` sessions | 0 |
| Residual validation processes | 0 |
| Network failure patterns | None found for `fetch failed`, `ETIMEDOUT`, `ECONNRESET`, `ENETUNREACH` |

## Real LLM Evidence

Every live round ended with `ok: true`, provider `openai`, `llmCalls.count=20`, `eventLogCount=56`, and `decisionLogCount=4`.

| Round | Time CST | OK | Calls | Tokens | Est. cost USD | Event logs | Decisions |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 3 | 18:13:56 | true | 20 | 12,125 | 0.002477 | 56 | 4 |
| 6 | 18:45:15 | true | 20 | 12,318 | 0.002592 | 56 | 4 |
| 9 | 19:16:30 | true | 20 | 12,264 | 0.002560 | 56 | 4 |
| 12 | 19:47:43 | true | 20 | 12,116 | 0.002471 | 56 | 4 |
| 15 | 20:18:59 | true | 20 | 12,162 | 0.002499 | 56 | 4 |
| 18 | 20:50:24 | true | 20 | 12,189 | 0.002476 | 56 | 4 |
| 21 | 21:21:54 | true | 20 | 12,183 | 0.002511 | 56 | 4 |
| 24 | 21:53:30 | true | 20 | 12,199 | 0.002520 | 56 | 4 |
| 27 | 22:25:03 | true | 20 | 12,252 | 0.002514 | 56 | 4 |
| 30 | 22:56:54 | true | 20 | 12,245 | 0.002512 | 56 | 4 |
| 33 | 23:28:39 | true | 20 | 12,237 | 0.002544 | 56 | 4 |
| 36 | 00:00:37 | true | 20 | 12,225 | 0.002498 | 56 | 4 |
| 39 | 00:32:15 | true | 20 | 12,135 | 0.002482 | 56 | 4 |
| 42 | 01:03:36 | true | 20 | 12,165 | 0.002501 | 56 | 4 |
| 45 | 01:35:06 | true | 20 | 12,133 | 0.002481 | 56 | 4 |
| 48 | 02:06:30 | true | 20 | 12,192 | 0.002516 | 56 | 4 |
| 51 | 02:37:57 | true | 20 | 12,146 | 0.002489 | 56 | 4 |
| 54 | 03:09:10 | true | 20 | 12,488 | 0.002694 | 56 | 4 |
| 57 | 03:40:51 | true | 20 | 12,105 | 0.002465 | 56 | 4 |
| 60 | 04:12:01 | true | 20 | 12,524 | 0.002671 | 56 | 4 |
| 63 | 04:43:37 | true | 20 | 12,119 | 0.002473 | 56 | 4 |
| 66 | 05:14:54 | true | 20 | 12,081 | 0.002451 | 56 | 4 |
| 69 | 05:46:08 | true | 20 | 12,332 | 0.002600 | 56 | 4 |

Totals:

| Metric | Value |
| --- | ---: |
| Live runs | 23 |
| Real LLM calls | 460 |
| Total tokens | 280,935 |
| Estimated cost | 0.057997 USD |
| Min tokens per live run | 12,081 |
| Max tokens per live run | 12,524 |
| Average tokens per live run | 12,214.57 |
| Min cost per live run | 0.002451 USD |
| Max cost per live run | 0.002694 USD |
| Average cost per live run | 0.002522 USD |

## Cognitive Iteration And Knowledge Entropy Evidence

The successful `e2e:llm-flywheel` assertions prove these properties on every live run:

| Property | Evidence |
| --- | --- |
| Multi-agent loop completed | Orchestrator, sensor, builder, distiller, and librarian ran in each of 4 cycles. |
| Knowledge reuse changed later decisions | Cycle 3 reasoning referenced prior knowledge and changed the selected direction. |
| Rejected directions stayed bounded | Rejected direction was not repeated in later plans. |
| Prediction error routed back | Cycle 1 prediction error was classified as model error and routed to distiller/world-model update. |
| Human-gate pressure stayed bounded | Pending human gates remained within the tested bound. |
| Cycle 4 compounded rather than repeated | Cycle 4 produced a rollback/audit-specific prediction, direction gate, and principle. |
| Knowledge base reduced decision entropy | Prior knowledge was cited, filtered, and reused to constrain future choices instead of accumulating unused text. |

This is enough for a stage-gate claim that the core design supports sustainable cognitive iteration and knowledge-base entropy reduction within the `e2e:llm-flywheel` acceptance boundary.

## Health And Delta Boundary

The default health endpoint was not serving during this 12-hour run:

| Item | Result |
| --- | --- |
| Health probes | 23 |
| Health response files | 23 empty files |
| `delta` column | `NA` for all 69 rounds |
| Direct `compoundingProof.round1vs4KnowledgeDelta` evidence | Not available from this run |

Therefore, entropy reduction is supported by live E2E behavior and assertions, not by the health API's `compoundingProof.round1vs4KnowledgeDelta` metric in this specific run.

## Post-Run Bug Fix

The completed 12-hour run used the pre-fix `scripts/12h_validation.sh` alert counter. During audit, we found that non-critical health failures did not trigger the intended 3-consecutive alert because successful `sim` or `live` steps reset the single global non-critical counter before the next health probe.

Fix made after the run:

- `scripts/12h_validation.sh` now tracks consecutive non-critical failures per check: `flywheel`, `live connectivity`, `e2e:llm-flywheel`, and `flywheel health`.
- `SKIP_NET` is counted as a non-critical live connectivity failure.
- Health probe failures are counted as non-critical failures.
- Alerts are still non-blocking; the runner continues after writing `alerts.log`.

Post-fix smoke command:

```bash
ALAYA_VALIDATION_DURATION_SECONDS=999 \
ALAYA_VALIDATION_SLEEP_SECONDS=0 \
ALAYA_VALIDATION_MAX_ROUNDS=9 \
ALAYA_CONNECT_TIMEOUT_SECONDS=1 \
ALAYA_LLM_CONNECTIVITY_URL=http://127.0.0.1:9 \
ALAYA_GITHUB_CONNECTIVITY_URL=http://127.0.0.1:9 \
ALAYA_HEALTH_URL=http://127.0.0.1:9 \
LLM_API_KEY=fake \
GH_PAT=fake \
bash scripts/12h_validation.sh
```

Post-fix smoke result:

```text
Completed | rounds=9 noncritical_errors=6 | summary: ./validation-logs/12h_20260606_101539/SUMMARY.csv | alerts: ./validation-logs/12h_20260606_101539/alerts.log
```

Alert file:

```text
2026-06-06T02:15:42Z,round=9,latest=live connectivity
2026-06-06T02:15:42Z,round=9,latest=flywheel health
```

This confirms that same-check non-critical failures alert after 3 consecutive occurrences and do not interrupt the run.

## Verification Commands

- `screen -ls`: no residual validation session.
- `ps aux | rg '12h_validation|e2e_real_llm|e2e:llm-flywheel|run_flywheel|alaya12h_20260605_175353'`: no residual validation process.
- `npm run validation:summary -- validation-logs/12h_20260605_175353/SUMMARY.csv`: 69 rounds, guard 69 PASS, sim 69 PASS, live 23 PASS / 46 SKIP.
- Live-log parser: 23 live logs parsed, all `ok: true`, 460 total LLM calls, 280,935 tokens, 0.057997 USD estimated cost.
- Error scan over launch/run logs: no `FAIL`, `ERROR`, `fetch failed`, `ETIMEDOUT`, `ECONNRESET`, `ENETUNREACH`, or timeout patterns, except the final completion line.
- `bash -n scripts/12h_validation.sh`: passed after alert-counter fix.
- `npm run test:scripts`: 18/18 passed after alert-counter fix.
- 9-round forced failure smoke: produced 2 alerts at round 9 and exited 0.
