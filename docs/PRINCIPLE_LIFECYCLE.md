# Principle Lifecycle

Alaya treats knowledge principles as governed runtime assets, not notes.

## States

| State | Meaning | Runtime use |
| --- | --- | --- |
| `draft` | Newly distilled knowledge, kept for review and evidence accumulation. | Not injected. |
| `candidate` | Compatibility alias for `draft`; used by benchmark/docs when emphasizing promotion flow. | Not injected. |
| `active` | Evidence-backed knowledge that can guide normal decisions. | Injectable. |
| `strong` | Active knowledge with enough evidence and explicit human approval. | Injectable and preferred. |
| `provisional` | Temporary candidate state retained for older fixtures. | Can promote like draft. |
| `stale` | Confidence decayed or validity expired. | Not injected. |
| `expired` | Stale beyond retention. | Not injected. |
| `conflict` | Contradicts comparable strong knowledge. | Not injected. |
| `quarantined` | Enough negative evidence to isolate it. | Not injected. |
| `deprecated` | Replaced by more specific or better supported knowledge. | Not injected. |
| `rejected` | Proven harmful by benchmark or human review. | Not injected. |

## Promotion Rules

- `draft/candidate/provisional -> active`: `confidenceScore >= 0.6` and at least one real evidence item.
- `active -> strong`: `confidenceScore >= 0.85`, evidence count >= 5, `humanApprovedCount >= 1`, and explicit human promotion.
- `active/strong -> stale`: time decay or validity expiry lowers confidence below the stale threshold.
- `any -> conflict/quarantined`: automatic safety isolation when contradiction or negative evidence is strong enough.
- `deprecated/rejected`: terminal for automatic decision use; reopening requires a future explicit implementation.

## Evidence Chain

Every meaningful lifecycle movement should be traceable:

```text
source cycle -> source trace/error -> knowledge update -> lifecycle transition -> future injection/use
```

The P0+P1 implementation records `principle_transition` trace events for Librarian transitions and scheduled time decay. It keeps the existing `event_log` intact and adds `trace_events` as the queryable evidence layer.
