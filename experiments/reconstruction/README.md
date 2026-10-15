# FunSearch M0 · offline calibration

This historical check reproduced a published algorithm on the original
20 public OR3 instances: Best Fit 212.0 bins, published heuristic 207.45 bins,
a 2.146226% improvement, all packings valid, and zero model requests.

Read the [saved result](../../docs/research/stage-2026-09-22/funsearch-reproduction.json)
and [research closeout](../../docs/research/RESEARCH_RELEASE_2026-10-15.zh-CN.md)
first. M0 calibrates known algorithmic advantage; it does not demonstrate new
search, Alaya memory, recursive improvement, or end-to-end validation of the
separate fixed-search M1 Docker evaluator.

## Inspect saved numbers · no model or upstream checkout

From the repository root, with Python 3:

~~~bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path("docs/research/stage-2026-09-22/funsearch-reproduction.json")
report = json.loads(path.read_text())
rows = report["perInstance"]
baseline = sum(row["bestFit"] for row in rows) / len(rows)
published = sum(row["publishedHeuristic"] for row in rows) / len(rows)
assert baseline == report["baselineMeanBins"]
assert published == report["publishedHeuristicMeanBins"]
gain = (baseline - published) / baseline * 100
assert abs(gain - report["relativeImprovementPercent"]) < 1e-9
print(f"instances={len(rows)}, {baseline} -> {published}, gain={gain:.6f}%")
print("recorded model requests:", report["llmRequests"])
PY
~~~

This checks the arithmetic of a saved report, not a fresh algorithm execution
or independent validation of its provenance.

## Optional historical reproduction

This setup fetches the fixed upstream and executes reviewed notebook cells
locally. It does not call a model. It is separate from the default release
checks and does not authorize another search or a live experiment.

~~~bash
mkdir -p tmp
git clone https://github.com/google-deepmind/funsearch.git tmp/funsearch
git -C tmp/funsearch checkout --detach cc53f274237d7ab05c19df939edbc1f9616a7c19
python3.12 -m venv tmp/funsearch-venv
tmp/funsearch-venv/bin/python -m pip install -r experiments/reconstruction/requirements.txt
tmp/funsearch-venv/bin/python experiments/reconstruction/reproduce_funsearch.py \
  --upstream tmp/funsearch \
  --output tmp/funsearch-reproduction-local.json
~~~

The script checks the upstream revision and a clean checkout. A fresh result
goes to `tmp/`; keep the archived result unchanged. The saved run used
Python 3.12.14 and NumPy 2.3.5. Reading the saved JSON needs only Python's
standard library.
