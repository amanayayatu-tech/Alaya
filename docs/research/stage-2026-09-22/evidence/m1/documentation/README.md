# Alaya M1 knowledge-transfer experiment

Isolated A/B check: same model, frozen task protocol, B gets a training-distilled snapshot. This is synthetic rule learning, not investment advice and not a product-capability claim.

Live provider calls stay blocked until both `--authorize-live` and `ALAYA_M1_AUTHORIZE_LIVE=1` are set.

## Commands

```bash
npm run m1:check
npm run m1:run
npm run m1:report
ALAYA_M1_AUTHORIZE_LIVE=1 npm run m1:run -- --authorize-live
```

Revision `ALAYA-M1.1-CONTRACT-PREFLIGHT` keeps the original 80-item protocol, but empty or failed K2 stops with `NO_CANDIDATE` before Dev.

```bash
npm run m1:preflight
ALAYA_M1_AUTHORIZE_LIVE=1 npm run m1:preflight -- --authorize-live
```

`m1:check` is the no-model gate. `m1:run` / `m1:preflight` without live authorization write `READY_FOR_AUTHORIZED_RUN` and do not call a model.
Preflight is `diagnostic_only`, capped at 12 provider requests / 30k tokens, and does not write official K1/K2.
The old run `validation-logs/m1/2026-09-19T09-19-20-583Z` is read-only.

Results go to `validation-logs/m1/<run-id>/` (`manifest.json`, `evidence.jsonl`, `knowledge.json`, `comparison.csv`, `report.md`). That directory is gitignored.

## Status

- `READY_FOR_AUTHORIZED_RUN`: engineering entry is ready; no live experiment.
- `INVALID`: leak, snapshot mix-up, or identity failure. Do not compare arms.
- `BLOCKED` / `PARTIAL`: unfinished (auth, budget, or interrupt). Keep evidence.
- `NO_SIGNAL_ON_DEV`: stop; do not chase Test.
- `PROMISING` / `NO_CLEAR_GAIN`: Test completed. PROMISING is only an engineering screen for a later real-task check.

PR-L6 is archived. This experiment does not restore PRECHECK3 or RUN-L7.
