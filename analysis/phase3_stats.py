#!/usr/bin/env python3
"""
Phase3 publication statistics — frozen analysis (write before pilot, do not edit after).

Input CSV (analysis/phase3_results.csv), one row per valid run:
  pair,arm,ece,faithfulness,scored,eligible,providerRatio,
  correctnessMode_truth_count,bucket8_n,bucket8_accuracy,bucket8_confMean,run_valid,reason

Runs the PRE-REGISTERED analysis:
  1. Pair the arms by `pair`, compute d_i = ece_adaptive - ece_disabled (positive => disabled better).
  2. PRIMARY: one-sided paired t-test, H1: mu_d > 0 (disabled superior on ECE).
  3. FALLBACK: TOST equivalence, margin Δ=0.02 (sensitivity Δ=0.01).
  4. Normality check (Shapiro) + Wilcoxon robustness.
  5. Descriptive faithfulness (NOT part of primary conclusion).

Usage: python3 phase3_stats.py analysis/phase3_results.csv
"""
import sys, csv
import numpy as np
from scipy import stats

DELTA_EQ = 0.02         # pre-registered equivalence margin
DELTA_EQ_SENS = 0.01    # sensitivity-only
ALPHA = 0.05

def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            if str(r.get("run_valid","1")).strip() not in ("1","true","True"):
                continue
            rows.append(r)
    return rows

def pair_diffs(rows):
    by_pair = {}
    for r in rows:
        by_pair.setdefault(r["pair"], {})[r["arm"]] = float(r["ece"])
    d = []
    used = []
    for p, arms in sorted(by_pair.items()):
        if "disabled" in arms and "adaptive" in arms:
            d.append(arms["adaptive"] - arms["disabled"])  # + => disabled better
            used.append(p)
    return np.array(d), used

def one_sided_paired_superiority(d):
    """H1: mu_d > 0."""
    n = len(d)
    mean = d.mean(); sd = d.std(ddof=1); se = sd/np.sqrt(n)
    tstat = mean/se
    df = n-1
    p_one = stats.t.sf(tstat, df)  # P(T > tstat) under H0
    ci = stats.t.interval(0.95, df, loc=mean, scale=se)
    return dict(n=n, mean=mean, sd=sd, se=se, t=tstat, df=df, p_one_sided=p_one, ci95=ci)

def tost(d, margin):
    n=len(d); mean=d.mean(); sd=d.std(ddof=1); se=sd/np.sqrt(n); df=n-1
    # H0_lower: mu <= -margin ; H0_upper: mu >= +margin
    t_lower = (mean - (-margin))/se
    p_lower = stats.t.sf(t_lower, df)      # reject if mu > -margin
    t_upper = (mean - (margin))/se
    p_upper = stats.t.cdf(t_upper, df)     # reject if mu < +margin
    p_tost = max(p_lower, p_upper)
    ci90 = stats.t.interval(0.90, df, loc=mean, scale=se)
    equivalent = (p_lower < ALPHA) and (p_upper < ALPHA)
    return dict(margin=margin, p_lower=p_lower, p_upper=p_upper, p_tost=p_tost,
                ci90=ci90, equivalent=equivalent)

def main():
    path = sys.argv[1] if len(sys.argv)>1 else "analysis/phase3_results.csv"
    rows = load(path)
    d, used = pair_diffs(rows)
    if len(d) < 2:
        print(f"Need >=2 valid pairs; got {len(d)} (pairs: {used})"); return
    print(f"== Valid pairs: {len(d)} ({used}) ==")
    print(f"d_i (adaptive - disabled): {np.round(d,4).tolist()}")
    print(f"mean d = {d.mean():.4f}  sd = {d.std(ddof=1):.4f}  (>0 => disabled better)\n")

    sup = one_sided_paired_superiority(d)
    print("-- PRIMARY: one-sided paired t-test (H1: disabled < adaptive on ECE) --")
    print(f"  t({sup['df']}) = {sup['t']:.3f}, one-sided p = {sup['p_one_sided']:.4f}")
    print(f"  mean diff = {sup['mean']:.4f}, 95% CI = [{sup['ci95'][0]:.4f}, {sup['ci95'][1]:.4f}]")
    primary_pass = (sup['p_one_sided'] < ALPHA) and (sup['mean'] > 0)
    print(f"  PRIMARY {'PASS -> publish: disabled significantly superior' if primary_pass else 'NOT significant -> go to TOST'}\n")

    # normality + robustness
    if len(d) >= 3:
        W,pn = stats.shapiro(d)
        print(f"-- Normality (Shapiro): W={W:.3f}, p={pn:.3f} ({'ok' if pn>0.05 else 'non-normal -> see Wilcoxon'})")
    try:
        wstat, wp = stats.wilcoxon(d, alternative='greater')
        print(f"-- Robustness (Wilcoxon, one-sided greater): p={wp:.4f}\n")
    except Exception as e:
        print(f"-- Wilcoxon n/a: {e}\n")

    print(f"-- FALLBACK: TOST equivalence, margin Δ=±{DELTA_EQ} --")
    t = tost(d, DELTA_EQ)
    print(f"  p_lower={t['p_lower']:.4f}, p_upper={t['p_upper']:.4f}, 90% CI=[{t['ci90'][0]:.4f},{t['ci90'][1]:.4f}]")
    print(f"  EQUIVALENT={t['equivalent']}  ({'publish: equivalent, default disabled justified' if t['equivalent'] else 'NOT equivalent'})")
    ts = tost(d, DELTA_EQ_SENS)
    print(f"  [sensitivity Δ=±{DELTA_EQ_SENS}] equivalent={ts['equivalent']}\n")

    # decision
    print("== PRE-REGISTERED VERDICT ==")
    if primary_pass:
        print("  Outcome 1: disabled SIGNIFICANTLY SUPERIOR.")
    elif t['equivalent']:
        print("  Outcome 2: arms EQUIVALENT within ±0.02 -> default disabled is justified.")
    else:
        print("  Outcome 3: INCONCLUSIVE. Report point estimate + required N; do NOT claim a direction.")

    # descriptive faithfulness (not part of conclusion)
    fa=[float(r["faithfulness"]) for r in rows if r["arm"]=="adaptive"]
    fd=[float(r["faithfulness"]) for r in rows if r["arm"]=="disabled"]
    if fa and fd:
        print(f"\n[descriptive only] faithfulness disabled={np.mean(fd):.4f} adaptive={np.mean(fa):.4f} (NOT part of primary conclusion)")

if __name__=="__main__":
    main()
