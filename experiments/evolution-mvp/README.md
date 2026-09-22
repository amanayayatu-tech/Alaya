# M1 fixed-search screen

This directory is a development-only adapter. It runs the pinned ShinkaEvolve
commit `9912af12d423504b8d580f4179fd15f5f88b8c50` against the public FunSearch
OR3 bin-packing data. The seed program is Best Fit; Shinka proposes at most
149 children, so the initial program plus children is at most 150 candidates
per seed.

`LocalJobConfig` only launches the evaluator subprocess. `evaluate.py` then
mounts the candidate and a tiny worker into a pinned Python Docker image with
no network, read-only root, dropped capabilities, non-root UID, CPU/memory/
PID limits, and a host timeout. The worker receives only current instances;
the candidate receives one current item and a copy of current capacities.

The run script deliberately has no total monetary stop. The pre-registered
candidate count and quality gate remain fixed. API credentials are supplied
only through `ALAYA_EVOLUTION_API_KEY`; they are never written to a manifest,
log, or Git file. If the provider does not report usage, the ledger records
`unknown`, never zero.

From the repository root, in a Python environment with Shinka installed at
the pinned commit:

```bash
python -m venv /tmp/alaya-shinka-m1-20260923
. /tmp/alaya-shinka-m1-20260923/bin/activate
pip install -e /tmp/alaya-research-20260922.zEA1vB/ShinkaEvolve
KEY_FILE=/Users/peachy/.config/alaya/openai-api-key
ALAYA_EVOLUTION_API_KEY="$(< "$KEY_FILE")" \
  python experiments/evolution-mvp/run_m1.py
```

The output is intentionally local and ignored by Git under
`experiments/evolution-mvp/outputs/`. Each seed has a train ledger, a frozen
dev-selected `champion.py`, and a test readback. Test is opened only after the
dev selection is frozen. This is a development screen, not a science or
publication result.
