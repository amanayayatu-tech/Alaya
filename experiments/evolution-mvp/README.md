# Fixed-search M1 · closed DEVELOPMENT screen

The 2026-09-23 run is complete and stopped at `go=false`. It used pinned
ShinkaEvolve `9912af12d423504b8d580f4179fd15f5f88b8c50`, MiniMax-M3,
and public FunSearch OR3 data split 10/5/5. Best Fit was the seed program.
Alaya memory, prompt evolution, and W&B were disabled.

All three seeds improved test score, by +0.572519%, +1.049618%, and
+0.095420%. The mean +0.572519% missed the ≥1% continuation gate; only one
seed reached ≥1%. M2/M3 did not run. See [RESULTS_M1.md](./RESULTS_M1.md) and
[research closeout](../../docs/research/RESEARCH_RELEASE_2026-10-15.zh-CN.md).
This is not a cognitive-enhancement or generalization result.

## Recalculate saved test scores without a model

The six [saved score files](./evidence/m1-fixed-search-v2-20260923/) are exact
copies of each seed's baseline-test and champion-test `score.json`. They
contain scores, candidate/evaluator hashes and the recorded container image.
The three frozen champion files are copied alongside them so their hashes and
algorithms can be inspected. These nine files are 11,136 bytes in total; they
do not contain credentials, HTTP messages, or private machine paths.

From the repository root, with Python 3:

~~~bash
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path("experiments/evolution-mvp/evidence/m1-fixed-search-v2-20260923")
gains = []
for seed in ("m1-01", "m1-02", "m1-03"):
    scores = [json.loads((root / seed / split / "score.json").read_text())
              for split in ("baseline-test", "test")]
    for score in scores:
        assert score["valid"]
        assert abs(sum(score["bins"]) / len(score["bins"]) - score["mean_bins"]) < 1e-9
    assert hashlib.sha256((root / seed / "champion.py").read_bytes()).hexdigest() == scores[1]["candidate_sha256"]
    baseline, champion = (score["mean_bins"] for score in scores)
    gain = (baseline - champion) / baseline * 100
    gains.append(gain)
    print(seed, f"{baseline:.1f} -> {champion:.1f}, gain={gain:.6f}%")
mean = sum(gains) / len(gains)
print(f"mean={mean:.6f}%, seeds >=1%={sum(g >= 1 for g in gains)}/3")
print("test continuation threshold passed:", mean >= 1 and sum(g >= 1 for g in gains) >= 2)
PY
~~~

This only recalculates arithmetic in saved test files. It does not rerun
Docker, reproduce model requests, check all train candidates, or independently
establish the original experiment's chronology.

## Evidence limits

- `requests.jsonl` in the original local output was materialized after search.
  Its rows index candidates and response files; `usage` and `api_cost` are
  `unknown`. It is not a per-HTTP request ledger or a billing record.
- `readback.json` was written by the runner. Its
  `test_was_run_after_dev_freeze` field is not an independent verification.
- The source selects a champion using dev scores before calling test, but
  source order and matching saved hashes do not replace an independent run.
- The public 5-instance test split is a development screen, not private
  held-out or cross-task generalization.
- `positive_seed_count` in the runner means improvement ≥1%, not merely >0.
  The historical restructure plan used different wording; the failed mean
  ≥1% condition makes the stop verdict unchanged under either wording.

## Historical live-search setup · not part of the release checks

This adapter remains for inspection. A new model search requires separate
authorization and a fresh output directory; the research closeout does not
request another M1. Obtain the fixed upstream without private or temporary
paths:

~~~bash
mkdir -p tmp
git clone https://github.com/SakanaAI/ShinkaEvolve.git tmp/ShinkaEvolve
git -C tmp/ShinkaEvolve checkout --detach 9912af12d423504b8d580f4179fd15f5f88b8c50
python3 -m venv tmp/shinka-venv
tmp/shinka-venv/bin/python -m pip install -e tmp/ShinkaEvolve
~~~

These commands fetch dependencies but do not start model search. Python 3.12
and Docker were used for the historical evaluator. `LocalJobConfig` launches
a subprocess; the security boundary for candidate execution is the Docker
worker with no network, read-only root, non-root UID and resource limits.

Only a separately authorized run should supply `ALAYA_EVOLUTION_API_KEY`
from a local secret store. Do not commit it. The historical runner has no
total monetary stop, so its candidate limit is not a total API-cost limit.
Do not reuse it as a default release check or overwrite old outputs.
