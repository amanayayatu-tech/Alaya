"""Run the pre-registered M1 fixed-search screen and freeze a readback."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from shinka.core import EvolutionConfig, ShinkaEvolveRunner
from shinka.database import DatabaseConfig
from shinka.launch import LocalJobConfig


ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / "outputs" / "m1-fixed-search"
SEEDS = ("m1-01", "m1-02", "m1-03")
MODEL = os.environ.get(
    "ALAYA_EVOLUTION_MODEL",
    "local/MiniMax-M3@https://api.minimax.io/v1?api_key_env=ALAYA_EVOLUTION_API_KEY",
)
SHINKA_COMMIT = "9912af12d423504b8d580f4179fd15f5f88b8c50"
IMAGE = "python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111"

TASK_SYS_MSG = """You are optimizing one online 1D bin-packing policy.

The candidate file must keep the EVOLVE-BLOCK markers and define exactly the
pure function choose_bin(item, remaining_capacities). Return a legal existing
bin index, or -1 to open one new bin. The evaluator sends one item at a time;
future items are unavailable. Minimize mean bins across the fixed OR3 task.
Use only Python syntax and the supplied arguments: no imports, filesystem,
network, randomness, timestamps, or changes outside the evolve block. A
candidate that raises, returns a non-integer, chooses an infeasible bin, or
otherwise violates the contract is invalid rather than repaired.
"""


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def install_provider_compat() -> dict[str, str]:
    """Keep MiniMax's reasoning trace out of Shinka's patch response budget."""
    if "MiniMax-M3" not in MODEL:
        return {"minimax_thinking": "not_applicable"}

    # Shinka's pinned local-OpenAI adapter does not expose provider-specific
    # request bodies through EvolutionConfig.  Patch its existing sampler at
    # the boundary instead of modifying the pinned dependency checkout.
    from shinka.llm import llm as shinka_llm

    original = shinka_llm.sample_model_kwargs
    if getattr(original, "_alaya_minimax_compat", False):
        return {"minimax_thinking": "disabled"}

    def sample_with_minimax_compat(*args, **kwargs):
        sampled = original(*args, **kwargs)
        if "MiniMax-M3" in sampled.get("model_name", ""):
            sampled["extra_body"] = {"thinking": {"type": "disabled"}}
        return sampled

    sample_with_minimax_compat._alaya_minimax_compat = True
    shinka_llm.sample_model_kwargs = sample_with_minimax_compat
    return {"minimax_thinking": "disabled"}


def runner_for(seed: str, run_dir: Path, python_executable: str) -> None:
    os.environ["ALAYA_EVOLUTION_SEED"] = seed
    os.environ["ALAYA_EVOLUTION_SPLIT"] = "train"
    evo_config = EvolutionConfig(
        task_sys_msg=TASK_SYS_MSG,
        patch_types=["diff", "full"],
        patch_type_probs=[0.75, 0.25],
        num_generations=150,  # generation 0 is the Best Fit seed; 149 proposals
        max_patch_resamples=1,
        max_patch_attempts=1,
        job_type="local",
        language="python",
        llm_models=[MODEL],
        llm_dynamic_selection="fixed",
        llm_dynamic_selection_kwargs={},
        llm_kwargs={"temperatures": [0.7], "max_tokens": [4096]},
        meta_rec_interval=None,
        meta_llm_models=None,
        embedding_model=None,
        init_program_path=str(ROOT / "initial.py"),
        results_dir=str(run_dir),
        enable_wandb_logging=False,
        max_api_costs=None,  # no total monetary stop; the 150-candidate screen remains fixed
        novelty_llm_models=None,
        evolve_prompts=False,
        enable_controlled_oversubscription=False,
    )
    db_config = DatabaseConfig(
        db_path=str(run_dir / "programs.sqlite"),
        num_islands=1,
        archive_size=150,
        num_archive_inspirations=1,
        num_top_k_inspirations=1,
        migration_interval=1000,
        migration_rate=0.0,
        enable_dynamic_islands=False,
        archive_selection_strategy="fitness",
        archive_criteria={"combined_score": 1.0},
    )
    job_config = LocalJobConfig(
        eval_program_path=str(ROOT / "evaluate.py"),
        python_executable=python_executable,
        time="00:05:00",
        eval_verbose=False,
        numeric_threads_per_job=1,
    )
    runner = ShinkaEvolveRunner(
        evo_config=evo_config,
        db_config=db_config,
        job_config=job_config,
        max_evaluation_jobs=1,
        max_proposal_jobs=1,
        max_db_workers=1,
        debug=False,
        verbose=True,
    )
    runner.run()


def generation_dirs(run_dir: Path) -> list[Path]:
    return sorted(
        (path for path in run_dir.glob("gen_*") if path.is_dir()),
        key=lambda path: int(path.name.split("_", 1)[1]),
    )


def evaluate_candidate(program: Path, result_dir: Path, split: str, seed: str) -> dict:
    env = os.environ.copy()
    env["ALAYA_EVOLUTION_SEED"] = seed
    env["ALAYA_EVOLUTION_SPLIT"] = split
    command = [
        sys.executable,
        str(ROOT / "evaluate.py"),
        "--program_path",
        str(program),
        "--results_dir",
        str(result_dir),
        "--split",
        split,
        "--seed",
        seed,
    ]
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    score_path = result_dir / "score.json"
    return json.loads(score_path.read_text(encoding="utf-8"))


def materialize_ledger(run_dir: Path, seed: str, train_rows: list[dict]) -> None:
    requests_path = run_dir / "requests.jsonl"
    results_path = run_dir / "results.jsonl"
    for row in train_rows:
        generation = row["generation"]
        generation_dir = run_dir / f"gen_{generation}"
        response_files = sorted(generation_dir.glob("**/llm_response.txt"))
        responses = [
            {
                "path": str(path.relative_to(run_dir)),
                "sha256": sha256_file(path),
            }
            for path in response_files
        ]
        with requests_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "event": "proposal_or_initial",
                        "recorded_at": now(),
                        "seed": seed,
                        "generation": generation,
                        "candidate_sha256": row["candidate_sha256"],
                        "response_files": responses,
                        "usage": "unknown",
                        "api_cost": "unknown",
                    },
                    sort_keys=True,
                )
                + "\n"
            )
        with results_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def inspect_train(run_dir: Path, seed: str) -> list[dict]:
    rows: list[dict] = []
    for generation_dir in generation_dirs(run_dir):
        program = generation_dir / "main.py"
        score_path = generation_dir / "results" / "score.json"
        if not program.exists() or not score_path.exists():
            continue
        score = json.loads(score_path.read_text(encoding="utf-8"))
        rows.append(
            {
                "seed": seed,
                "generation": int(generation_dir.name.split("_", 1)[1]),
                "candidate_sha256": sha256_file(program),
                "valid": bool(score.get("valid")),
                "legal_rate": score.get("legal_rate"),
                "mean_bins": score.get("mean_bins"),
                "error": score.get("error"),
                "score_path": str(score_path.relative_to(run_dir)),
            }
        )
    return rows


def finish_seed(run_dir: Path, seed: str, python_executable: str) -> dict:
    train_rows = inspect_train(run_dir, seed)
    if not train_rows:
        raise RuntimeError(f"NO_TRAIN_RESULTS:{seed}")
    materialize_ledger(run_dir, seed, train_rows)
    dev_rows: list[dict] = []
    for row in train_rows:
        program = run_dir / f"gen_{row['generation']}" / "main.py"
        dev_dir = run_dir / f"gen_{row['generation']}" / "dev"
        score = evaluate_candidate(program, dev_dir, "dev", seed)
        dev_rows.append(
            {
                "generation": row["generation"],
                "candidate_sha256": row["candidate_sha256"],
                "valid": bool(score.get("valid")),
                "legal_rate": score.get("legal_rate"),
                "mean_bins": score.get("mean_bins"),
                "error": score.get("error"),
            }
        )
    valid_dev = [row for row in dev_rows if row["valid"]]
    if not valid_dev:
        raise RuntimeError(f"NO_VALID_DEV_CANDIDATE:{seed}")
    champion_row = min(valid_dev, key=lambda row: (row["mean_bins"], row["generation"]))
    champion_source = run_dir / f"gen_{champion_row['generation']}" / "main.py"
    champion = run_dir / "champion.py"
    shutil.copyfile(champion_source, champion)
    champion_sha = sha256_file(champion)
    test_score = evaluate_candidate(champion, run_dir / "test", "test", seed)
    baseline_scores: dict[str, dict] = {}
    for split in ("dev", "test"):
        baseline_scores[split] = evaluate_candidate(
            ROOT / "initial.py", run_dir / f"baseline-{split}", split, seed
        )
    improvement = None
    if test_score.get("valid") and baseline_scores["test"].get("mean_bins"):
        improvement = (
            baseline_scores["test"]["mean_bins"] - test_score["mean_bins"]
        ) / baseline_scores["test"]["mean_bins"] * 100
    payload = {
        "seed": seed,
        "candidate_count": len(train_rows),
        "train_valid_candidate_rate": sum(row["valid"] for row in train_rows) / len(train_rows),
        "train": train_rows,
        "dev_selection": {
            "candidate_count": len(dev_rows),
            "valid_count": sum(row["valid"] for row in dev_rows),
            "champion_generation": champion_row["generation"],
            "champion_sha256": champion_sha,
            "champion_dev_mean_bins": champion_row["mean_bins"],
            "rows": dev_rows,
        },
        "baseline": baseline_scores,
        "test": test_score,
        "test_improvement_percent": improvement,
        "python_executable": python_executable,
    }
    write_json(run_dir / "summary.json", payload)
    write_json(
        run_dir / "readback.json",
        {
            "seed": seed,
            "champion_path": str(champion),
            "champion_sha256": champion_sha,
            "test_score_path": str((run_dir / "test" / "score.json")),
            "requests_path": str(run_dir / "requests.jsonl"),
            "results_path": str(run_dir / "results.jsonl"),
            "test_was_run_after_dev_freeze": True,
        },
    )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed", choices=SEEDS, action="append")
    parser.add_argument("--skip-run", action="store_true")
    args = parser.parse_args()
    if not os.environ.get("ALAYA_EVOLUTION_API_KEY", "").strip():
        raise SystemExit("ALAYA_EVOLUTION_API_KEY is required and is never written to the repo")
    provider_compat = install_provider_compat()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    seeds = tuple(args.seed or SEEDS)
    protocol = {
        "status": "DEVELOPMENT",
        "stage": "M1_FIXED_SEARCH_SCREEN",
        "created_at": now(),
        "base_repo_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "shinka_commit": SHINKA_COMMIT,
        "model": MODEL,
        "temperature": 0.7,
        "max_output_tokens": 4096,
        "candidate_budget_per_seed": 150,
        "proposal_generations_per_seed": 149,
        "seeds": list(seeds),
        "search": {"prompt_evolution": False, "alaya_memory": False, "wandb": False},
        "provider_compat": provider_compat,
        "evaluator": {
            "dataset": str((ROOT / "or3.json").resolve()),
            "dataset_sha256": sha256_file(ROOT / "or3.json"),
            "image": IMAGE,
            "split": {"train": 10, "dev": 5, "test": 5},
        },
        "cost_policy": "NO_TOTAL_BUDGET_STOP; usage remains recorded or unknown",
        "go": {"positive_seeds": 2, "mean_test_improvement_percent": 1.0, "legal_candidate_rate": 0.95},
    }
    write_json(output / "protocol.json", protocol)
    python_executable = sys.executable
    all_summaries: list[dict] = []
    for seed in seeds:
        run_dir = output / seed
        if run_dir.exists() and any(run_dir.iterdir()):
            if not args.skip_run and not (run_dir / "summary.json").exists():
                raise SystemExit(f"REFUSE_OVERWRITE_PARTIAL_RUN:{run_dir}")
        else:
            run_dir.mkdir(parents=True, exist_ok=True)
        if not args.skip_run and not (run_dir / "summary.json").exists():
            write_json(run_dir / "started.json", {"seed": seed, "started_at": now()})
            runner_for(seed, run_dir, python_executable)
        if not (run_dir / "summary.json").exists():
            all_summaries.append(finish_seed(run_dir, seed, python_executable))
        else:
            all_summaries.append(json.loads((run_dir / "summary.json").read_text(encoding="utf-8")))
    positive = [
        summary
        for summary in all_summaries
        if summary.get("test_improvement_percent") is not None
        and summary["test_improvement_percent"] >= 1.0
    ]
    rates = [summary.get("train_valid_candidate_rate", 0.0) for summary in all_summaries]
    improvements = [summary["test_improvement_percent"] for summary in all_summaries if summary.get("test_improvement_percent") is not None]
    mean_improvement = sum(improvements) / len(improvements) if improvements else None
    gate = {
        "completed_seeds": len(all_summaries) == len(seeds),
        "all_candidate_legal_rate_ge_95": bool(rates) and min(rates) >= 0.95,
        "positive_seed_count": len(positive),
        "positive_seed_count_ge_2": len(positive) >= 2,
        "mean_test_improvement_percent": mean_improvement,
        "mean_test_improvement_ge_1": mean_improvement is not None and mean_improvement >= 1.0,
        "go": len(positive) >= 2 and mean_improvement is not None and mean_improvement >= 1.0 and bool(rates) and min(rates) >= 0.95,
    }
    write_json(output / "summary.json", {"protocol": protocol, "seeds": all_summaries, "gate": gate})
    print(json.dumps({"output": str(output), "gate": gate}, indent=2))


if __name__ == "__main__":
    main()
