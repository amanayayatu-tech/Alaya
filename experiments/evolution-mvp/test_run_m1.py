"""Offline regressions for preserving existing M1 output provenance."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


# Loading the CLI must not require installing or invoking the search provider.
modules = {name: types.ModuleType(name) for name in (
    "shinka", "shinka.core", "shinka.database", "shinka.launch",
)}
for name, classes in {
    "shinka.core": ("EvolutionConfig", "ShinkaEvolveRunner"),
    "shinka.database": ("DatabaseConfig",),
    "shinka.launch": ("LocalJobConfig",),
}.items():
    for cls in classes:
        setattr(modules[name], cls, object)
spec = importlib.util.spec_from_file_location("run_m1", Path(__file__).with_name("run_m1.py"))
runner = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, modules):
    spec.loader.exec_module(runner)


def snapshot(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*") if path.is_file()
    }


class OutputProvenanceTests(unittest.TestCase):
    def invoke(self, output, skip_run=False):
        args = ["run_m1.py", "--output", str(output), "--seed", "m1-01"]
        if skip_run:
            args.append("--skip-run")
        summary = {"seed": "m1-01", "test_improvement_percent": 0.5,
                   "train_valid_candidate_rate": 1.0}
        with patch.dict(os.environ, {"ALAYA_EVOLUTION_API_KEY": "offline-test-only"}, clear=True), \
             patch.object(sys, "argv", args), \
             patch.object(runner, "MODEL", "offline-new-model"), \
             patch.object(runner, "install_provider_compat", return_value={}), \
             patch.object(runner.subprocess, "check_output", return_value="offline-new-head\n"), \
             patch.object(runner, "runner_for") as search, \
             patch.object(runner, "finish_seed", return_value=summary) as finish, \
             contextlib.redirect_stdout(io.StringIO()):
            error = None
            try:
                runner.main()
            except SystemExit as exc:
                error = exc
            return error, search.call_count, finish.call_count

    def test_completed_and_partial_outputs_remain_unchanged(self):
        for completed in (True, False):
            for skip_run in (False, True):
                with self.subTest(completed=completed, skip_run=skip_run), tempfile.TemporaryDirectory() as tmp:
                    output = Path(tmp)
                    (output / "protocol.json").write_text(json.dumps({
                        "created_at": "2026-09-23T00:00:00Z", "model": "old-model",
                        "base_repo_head": "old-head", "seeds": ["m1-01"],
                    }))
                    seed = output / "m1-01"
                    seed.mkdir()
                    (seed / "results.jsonl").write_text('{"preserved":true}\n')
                    if completed:
                        (seed / "summary.json").write_text(json.dumps({
                            "seed": "m1-01", "test_improvement_percent": 0.25,
                            "train_valid_candidate_rate": 1.0,
                        }))
                        (output / "summary.json").write_text('{"original_result":true}\n')
                    before = snapshot(output)
                    error, searches, finishes = self.invoke(output, skip_run)
                    self.assertEqual(snapshot(output), before)
                    self.assertIsNotNone(error)
                    self.assertIn("REFUSE_OVERWRITE_OUTPUT", str(error))
                    self.assertEqual((searches, finishes), (0, 0))

    def test_unrelated_existing_artifact_is_also_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "previous-evidence.json").write_text('{"preserved":true}\n')
            before = snapshot(output)
            error, searches, finishes = self.invoke(output)
            self.assertEqual(snapshot(output), before)
            self.assertIsNotNone(error)
            self.assertEqual((searches, finishes), (0, 0))

    def test_fresh_and_empty_outputs_still_follow_the_existing_path(self):
        for exists in (False, True):
            with self.subTest(exists=exists), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "new-run"
                if exists:
                    output.mkdir()
                error, searches, finishes = self.invoke(output)
                self.assertIsNone(error)
                self.assertEqual((searches, finishes), (1, 1))
                protocol = json.loads((output / "protocol.json").read_text())
                self.assertEqual(protocol["model"], "offline-new-model")
                self.assertEqual(json.loads((output / "summary.json").read_text())["protocol"], protocol)


if __name__ == "__main__":
    unittest.main()
