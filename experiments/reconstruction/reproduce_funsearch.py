"""Offline published-algorithm calibration, NOT a new discovery or RSI result.

Requires numpy and the pinned official FunSearch checkout passed via --upstream.
Executes reviewed upstream notebook cells, not any model-generated code.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time

import numpy as np

UPSTREAM_SHA = "cc53f274237d7ab05c19df939edbc1f9616a7c19"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    actual = subprocess.check_output(["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
    if actual != UPSTREAM_SHA:
        raise SystemExit("Upstream revision does not match the reviewed revision")
    if subprocess.check_output(["git", "-C", str(args.upstream), "status", "--porcelain"], text=True).strip():
        raise SystemExit("Upstream checkout must be clean")
    notebook = args.upstream / "bin_packing/bin_packing.ipynb"
    raw = notebook.read_bytes()
    cells = json.loads(raw)["cells"]
    source = lambda index: "".join(cells[index]["source"])
    scope = {}
    exec(compile(source(2), "upstream-datasets", "exec"), scope)
    exec(compile(source(4), "upstream-skeleton-best-fit", "exec"), scope)
    dataset = scope["datasets"]["OR3"]

    def evaluate():
        counts = []
        for name, instance in dataset.items():
            capacities = np.full(instance["num_items"], instance["capacity"])
            packing, remaining = scope["online_binpack"](instance["items"], capacities)
            # Independently verify conservation, bin capacity and used-bin count.
            assert sorted(item for one_bin in packing for item in one_bin) == sorted(instance["items"])
            assert all(sum(one_bin) <= instance["capacity"] for one_bin in packing)
            assert len(packing) == int(np.count_nonzero(remaining != instance["capacity"]))
            counts.append({"instance": name, "bins": len(packing)})
        return counts

    baseline = evaluate()
    tree = ast.parse(source(8))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "priority"]
    assert len(functions) == 1
    exec(compile(ast.Module(body=functions, type_ignores=[]), "upstream-discovered-priority", "exec"), scope)
    discovered = evaluate()
    before = sum(row["bins"] for row in baseline) / len(baseline)
    after = sum(row["bins"] for row in discovered) / len(discovered)
    report = {
        "evidence": "DEVELOPMENT_OFFLINE_PUBLISHED_ALGORITHM_REPRODUCTION",
        "status": "PUBLISHED_ADVANTAGE_REPRODUCED" if after < before else "NO_PUBLISHED_ADVANTAGE_REPRODUCED",
        "upstream": "https://github.com/google-deepmind/funsearch",
        "upstreamCommit": actual,
        "notebookSha256": hashlib.sha256(raw).hexdigest(),
        "dataset": "OR3, original 20 instances, original item order/capacity/scoring",
        "datasetSha256": hashlib.sha256(json.dumps(dataset, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "python": platform.python_version(), "numpy": np.__version__,
        "baselineMeanBins": before, "publishedHeuristicMeanBins": after,
        "relativeImprovementPercent": (before - after) / before * 100,
        "perInstance": [{"instance": a["instance"], "bestFit": a["bins"], "publishedHeuristic": b["bins"]} for a,b in zip(baseline, discovered)],
        "allPackingsValid": True, "llmRequests": 0, "providerTokens": 0,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "limits": ["Published known solutions on a public benchmark; no new algorithm search", "Not a reproduction of training or the full paper", "No private held-out generalization, self-modification, or recursive inheritance claim", "No changes to old Alaya P1 results or thresholds"]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ["status", "baselineMeanBins", "publishedHeuristicMeanBins", "relativeImprovementPercent", "allPackingsValid", "llmRequests", "elapsedSeconds"]}))
    if after >= before:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
