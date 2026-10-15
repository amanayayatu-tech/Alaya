"""Fixed OR3 evaluator for the M1 Shinka screen.

The evaluator owns the dataset and sends only the current item plus current
remaining capacities into a non-root, no-network Docker worker.  Shinka's
LocalJobConfig is only a host subprocess launcher; it is not the sandbox.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from statistics import mean

from shinka.core import run_shinka_eval


CAPACITY = 150
IMAGE = "python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111"
ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "or3.json"
WORKER_PATH = ROOT / "worker.py"
PROGRAM_PATH = ""
RESULTS_DIR = ""
ACTIVE_SPLIT = "train"
ACTIVE_SEED = "m1-01"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_instances(split: str) -> list[dict]:
    payload = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    names = payload["splits"][split]
    return [payload["instances"][name] for name in names]


def best_fit(items: list[int]) -> int:
    remaining: list[int] = []
    for item in items:
        choices = [
            (space, index)
            for index, space in enumerate(remaining)
            if space >= item
        ]
        if not choices:
            remaining.append(CAPACITY - item)
        else:
            _, index = min(choices)
            remaining[index] -= item
    return len(remaining)


def score_in_docker(program_path: Path, instances: list[dict]) -> dict:
    started = time.monotonic()
    candidate_sha = sha256_file(program_path)
    request = {"instances": [row["items"] for row in instances]}
    command = [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network=none",
        "--read-only",
        "--ipc=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--cpus=1",
        "--user=65534:65534",
        "--mount",
        f"type=bind,src={program_path},dst=/candidate.py,readonly",
        "--mount",
        f"type=bind,src={WORKER_PATH},dst=/worker.py,readonly",
        IMAGE,
        "python",
        "/worker.py",
    ]
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(request) + "\n",
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "valid": False,
            "legal_rate": 0.0,
            "mean_bins": None,
            "bins": [],
            "error": "CANDIDATE_TIMEOUT",
            "candidate_sha256": candidate_sha,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    stderr = completed.stderr[-2000:]
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if completed.returncode != 0 or not lines:
        return {
            "valid": False,
            "legal_rate": 0.0,
            "mean_bins": None,
            "bins": [],
            "error": f"WORKER_EXIT:{completed.returncode}:{stderr}"[:2000],
            "candidate_sha256": candidate_sha,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    try:
        result = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        result = {"error": f"BAD_WORKER_JSON:{error}"}
    if result.get("error"):
        return {
            "valid": False,
            "legal_rate": 0.0,
            "mean_bins": None,
            "bins": [],
            "error": str(result["error"])[:2000],
            "candidate_sha256": candidate_sha,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    bins = result.get("counts")
    if not isinstance(bins, list) or len(bins) != len(instances):
        return {
            "valid": False,
            "legal_rate": 0.0,
            "mean_bins": None,
            "bins": [],
            "error": "BAD_WORKER_COUNTS",
            "candidate_sha256": candidate_sha,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    return {
        "valid": True,
        "legal_rate": 1.0,
        "mean_bins": mean(bins),
        "bins": bins,
        "error": None,
        "candidate_sha256": candidate_sha,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "stderr": stderr,
    }


def run_binpack(seed: str = "m1-01") -> dict:
    del seed  # the public OR3 calibration task is fixed; seed controls the search.
    split = os.environ.get("ALAYA_EVOLUTION_SPLIT", ACTIVE_SPLIT)
    program_path = Path(os.environ["ALAYA_EVOLUTION_PROGRAM_PATH"])
    results_dir = os.environ.get("ALAYA_EVOLUTION_RESULTS_DIR", RESULTS_DIR)
    instances = load_instances(split)
    score = score_in_docker(program_path, instances)
    score.update(
        {
            "split": split,
            "search_seed": os.environ.get("ALAYA_EVOLUTION_SEED", ACTIVE_SEED),
            "dataset_sha256": sha256_file(DATA_PATH),
            "evaluator_sha256": sha256_file(Path(__file__).resolve()),
            "worker_sha256": sha256_file(WORKER_PATH),
            "container_image": IMAGE,
        }
    )
    if results_dir:
        result_path = Path(results_dir) / "score.json"
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(score, indent=2) + "\n", encoding="utf-8")
    return score


def aggregate(results: list[dict]) -> dict:
    score = results[0]
    # Shinka maximizes fitness while this task minimizes bins.
    return {
        "combined_score": -float(score["mean_bins"])
        if score["valid"]
        else -float(CAPACITY),
        "public": {
            "valid": bool(score["valid"]),
            "legal_rate": score["legal_rate"],
            "mean_bins": score["mean_bins"],
            "split": score["split"],
            "search_seed": score["search_seed"],
        },
        "private": {
            "bins": score.get("bins", []),
            "error": score.get("error"),
            "elapsed_ms": score.get("elapsed_ms"),
            "candidate_sha256": score.get("candidate_sha256"),
            "dataset_sha256": score["dataset_sha256"],
            "evaluator_sha256": score["evaluator_sha256"],
            "worker_sha256": score["worker_sha256"],
            "container_image": score["container_image"],
        },
    }


def validate(result: dict) -> tuple[bool, str | None]:
    if result.get("valid") and result.get("legal_rate") == 1.0:
        return True, None
    return False, str(result.get("error") or "INVALID_CANDIDATE")


def main() -> None:
    global ACTIVE_SEED, ACTIVE_SPLIT, PROGRAM_PATH, RESULTS_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--program_path", required=True)
    parser.add_argument("--results_dir", required=True)
    parser.add_argument("--split", choices=("train", "dev", "test"), default="train")
    parser.add_argument("--seed", default=os.environ.get("ALAYA_EVOLUTION_SEED", "m1-01"))
    args = parser.parse_args()
    PROGRAM_PATH = str(Path(args.program_path).resolve())
    RESULTS_DIR = str(Path(args.results_dir).resolve())
    ACTIVE_SPLIT = args.split
    ACTIVE_SEED = args.seed
    os.environ["ALAYA_EVOLUTION_PROGRAM_PATH"] = PROGRAM_PATH
    os.environ["ALAYA_EVOLUTION_RESULTS_DIR"] = RESULTS_DIR
    os.environ["ALAYA_EVOLUTION_SPLIT"] = ACTIVE_SPLIT
    os.environ["ALAYA_EVOLUTION_SEED"] = ACTIVE_SEED
    Path(RESULTS_DIR).mkdir(parents=True, exist_ok=True)
    metrics, correct, error = run_shinka_eval(
        # The experiment function belongs to this evaluator; PROGRAM_PATH is
        # the candidate mounted into the worker by score_in_docker().
        program_path=str(Path(__file__).resolve()),
        results_dir=RESULTS_DIR,
        experiment_fn_name="run_binpack",
        num_runs=1,
        get_experiment_kwargs=lambda _index: {"seed": ACTIVE_SEED},
        validate_fn=validate,
        aggregate_metrics_fn=aggregate,
        run_workers=1,
        verbose=False,
    )
    print(json.dumps({"metrics": metrics, "correct": correct, "error": error}))


if __name__ == "__main__":
    main()
