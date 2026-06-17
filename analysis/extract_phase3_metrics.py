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
import sys, json

def g(d, *path, default=""):
    cur=d
    for k in path:
        if isinstance(cur, dict) and k in cur:
            cur=cur[k]
        else:
            sys.stderr.write(f"WARN missing path: {'/'.join(map(str,path))}\n")
            return default
    return cur

def main():
    qpath, arm, pair = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(qpath) as f:
        q=json.load(f)

    # calibration block — adjust these paths to match real schema if needed
    cal = q.get("calibration") or q.get("confidenceCalibration") or {}
    ece = cal.get("ece", "")
    scored = cal.get("sampleSize") or cal.get("scored") or ""
    eligible = cal.get("eligible") or cal.get("eligibleCount") or ""
    rel = cal.get("reliabilityTable") or []

    # faithfulness
    faith = (q.get("faithfulness", {}) or {}).get("score") or q.get("faithfulnessScore") or ""

    # provider ratio
    prov = q.get("providerRatio") or g(q, "provider", "ratio", default="")

    # correctnessMode truth count
    rows = cal.get("rows") or []
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

    fields=[pair, arm, ece, faith, scored, eligible, prov, truth_ct,
            b8_n, b8_acc, b8_conf, run_valid, reason]
    print(",".join(str(x) for x in fields))

if __name__=="__main__":
    main()
