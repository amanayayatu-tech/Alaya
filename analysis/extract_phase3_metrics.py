#!/usr/bin/env python3
"""
Extract one CSV row of pre-registered metrics from a run's quality_summary.json.
Run on the Mac after each valid run.

Usage:
  python3 extract_phase3_metrics.py <quality_summary.json> <arm: disabled|adaptive> <pairXX>
Appends one CSV line to stdout. First run, prepend the header manually (see RUN_PLAYBOOK §4).

NOTE: key paths below follow the expected shape of evaluateConfidenceCalibration output.
Verify against an actual quality_summary.json on first use; adjust the .get() paths if the
schema nests differently. The script prints a WARN to stderr for any missing field rather
than crashing, so you can correct paths without losing data.
"""
import csv
import json
import sys
from pathlib import Path

def pick(*values, default=""):
    for value in values:
        if value not in (None, ""):
            return value
    return default

def path_get(d, *path, default=""):
    cur = d
    for k in path:
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur

def warn_if_missing(name, value):
    if value in (None, ""):
        sys.stderr.write(f"WARN missing field: {name}\n")

def load_json(path):
    with open(path) as f:
        return json.load(f)

def main():
    if len(sys.argv) != 4:
        sys.stderr.write("Usage: python3 analysis/extract_phase3_metrics.py <quality_summary.json> <disabled|adaptive> <pairXX>\n")
        sys.exit(2)
    qpath, arm, pair = sys.argv[1], sys.argv[2], sys.argv[3]
    arm = {"base": "disabled", "treat": "adaptive"}.get(arm, arm)
    if arm not in ("disabled", "adaptive"):
        sys.stderr.write(f"ERROR arm must be disabled or adaptive, got {arm!r}\n")
        sys.exit(2)

    q=load_json(qpath)
    summary_path = Path(qpath).with_name("summary.json")
    summary = load_json(summary_path) if summary_path.exists() else {}

    # calibration block — adjust these paths to match real schema if needed
    cal = q.get("calibration") or q.get("confidenceCalibration") or {}
    ece = pick(cal.get("ece"))
    scored = pick(cal.get("sampleSize"), cal.get("scored"))
    eligible = cal.get("eligible") or cal.get("eligibleCount") or ""
    rel = cal.get("reliabilityTable") or []

    # faithfulness
    faith_obj = q.get("faithfulness", {}) or {}
    faith = pick(faith_obj.get("faithfulness"), faith_obj.get("score"), q.get("faithfulnessScore"))

    # provider ratio
    prov = pick(
        q.get("providerRatio"),
        path_get(summary, "assessment", "observed", "lastLlmTokenSourceStats", "providerRatio"),
        path_get(q, "provider", "ratio"),
    )

    # correctnessMode truth count
    mode_counts = cal.get("correctnessModeCounts") or {}
    truth_ct = mode_counts.get("calibration_truth_decision")
    if truth_ct in (None, ""):
        rows = cal.get("rows") or cal.get("scoredKnowledge") or []
        truth_ct = sum(1 for r in rows if str(r.get("correctnessMode","")).startswith("calibration_truth"))

    # bucket 8 (confidence 0.8-0.9) — the injected-sample bucket; the down-drill命门
    b8 = next((b for b in rel if b.get("bucket")==8), {})
    b8_n = b8.get("n","")
    b8_acc = b8.get("accuracy","")
    b8_conf = b8.get("confMean","")

    run_valid = 1
    reason = ""
    # auto-flag obvious invalidity (still must be confirmed by human down-drill)
    try:
        if b8_acc != "" and float(b8_acc) <= 0.05 and b8_n and int(b8_n) >= 10:
            run_valid = 0; reason = "bucket8 accuracy~0 systematic -> metric invalid, re-run"
    except Exception:
        pass

    for name, value in (
        ("ece", ece),
        ("faithfulness", faith),
        ("scored", scored),
        ("eligible", eligible),
        ("providerRatio", prov),
        ("correctnessMode_truth_count", truth_ct),
    ):
        warn_if_missing(name, value)

    fields=[pair, arm, ece, faith, scored, eligible, prov, truth_ct,
            b8_n, b8_acc, b8_conf, run_valid, reason]
    csv.writer(sys.stdout, lineterminator="\n").writerow(fields)

if __name__=="__main__":
    main()
