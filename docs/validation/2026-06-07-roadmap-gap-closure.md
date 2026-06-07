# 2026-06-07 Roadmap Gap Closure Validation

## Scope

This pass closes the remaining roadmap gaps for:

- knowledge conflict detection, expiry/stale reminders and review workflow,
- Builder Codex/Codex CLI dry-run change package adapter,
- provider canary, LLM failure taxonomy and per-agent latency metrics,
- real usage operational KPI API,
- generic business signal CSV/JSON adapter,
- organization module template, Markdown export and draft knowledge conversion.

## Focused Tests

```bash
cd alaya-app && node --import tsx --test \
  tests/knowledgeReview.test.ts \
  tests/builderAdapter.test.ts \
  tests/providerCanary.test.ts \
  tests/opsMetrics.test.ts \
  tests/businessSignals.test.ts \
  tests/orgModules.test.ts \
  tests/shadowMode.test.ts \
  tests/routes.validation.test.ts
```

Result: PASS, 42/42.

## Smoke Benchmark

```bash
npm run benchmark:smoke
```

Result: PASS, 12/12 benchmark cases.

New smoke cases:

| Case | Coverage |
| --- | --- |
| `builder_codex_change_package` | rollback-ready dry-run Builder package and action-ledger audit |
| `provider_canary_and_latency_metrics` | mock canary and per-agent latency aggregation |
| `business_signal_requires_meaning_gate` | business signal enters Meaning Gate before knowledge |
| `ops_metrics_empty_dataset_safe` | safe KPI output on empty project |
| `org_module_draft_knowledge_not_injected` | org module conversion stays draft and excluded from prior knowledge |

## Required Command Set

| Command | Result | Notes |
| --- | --- | --- |
| `npm run guard` | PASS | 17/17 governance checks passed. |
| `npm run typecheck` | PASS | `alaya-core` `tsc --noEmit` and `alaya-app` `tsc` passed. |
| `npm run test:all` | PASS | Core 52/52, app 156/156, scripts 18/18. |
| `npm run build` | PASS | Client and server built. Vite emitted a non-blocking PostCSS `from` option warning. |
| `npm run benchmark:smoke` | PASS | 12/12 benchmark cases passed. |
| `npm run flywheel` | PASS | Mock four-cycle flywheel validation passed; 2 strong knowledge items, 20 agent runs, 56 event-log rows. |
| `npm run e2e:long-evolution` | PASS | 20 cycles, no `scenario_exhausted`, pending blocking gates = 0. |
| `npm run secret:scan` | PASS | No high-confidence secrets found. |

## Traceability Matrix

| Feature | Tests | Evidence/API |
| --- | --- | --- |
| Knowledge conflict/review | `knowledgeReview.test.ts` | `/api/projects/:id/knowledge/conflicts/scan`, `/api/knowledge-reviews/:id/resolve`, `knowledge_review_items`, `event_log`, `trace_events`, `action_ledger` |
| Builder adapter | `builderAdapter.test.ts`, benchmark | `/api/projects/:id/builder/codex/plan`, `/api/builder/codex/apply`, `action_ledger` |
| Provider canary and LLM taxonomy | `providerCanary.test.ts`, benchmark | `/api/projects/:id/provider-canary`, `npm run provider:canary`, `llm_calls.llm_failure_type`, `/api/llm-calls/latency`, `/metrics` |
| Ops KPIs | `opsMetrics.test.ts`, benchmark | `/api/projects/:id/ops-metrics`, raw `human_gate_items`, `llm_calls`, `predictions`, `knowledge_items`, `trace_events` |
| Business signals | `businessSignals.test.ts`, benchmark | `/api/projects/:id/business-signals/import`, `external_business_signals`, `feedback_items`, `human_gate_items` |
| Org modules | `orgModules.test.ts`, benchmark | `/api/projects/:id/org-modules`, `/api/org-modules/:id/markdown`, draft knowledge conversion |
| Long-run capability mapping | `shadowMode.test.ts`, `routes.validation.test.ts` | mutating API capability middleware, `action_ledger`, validation 400 responses |

## Residual Risks

- UI panels for the new APIs are intentionally deferred; API/tests/docs landed first to keep the change small.
- The Codex CLI adapter does not execute shell commands or apply patches automatically. Non-dry-run apply only records an approved manual apply path after capability + matching risk gate.
- Provider canary tests run with mock provider only. Real OpenAI-compatible canary remains opt-in with `ALAYA_CAP_LLM_CALL=true` and real secrets.
- Business signal import stores only redacted summaries for sensitive payloads; richer local encrypted storage is future work.
