#!/usr/bin/env python3
"""
Phase3 pilot decision — estimate sigma_d from first pilot pairs, recommend final N.
Run after the first 2 valid pairs (4 runs). Output goes into validation-logs/phase3_N_decision.md.

Usage: python3 phase3_pilot_decision.py analysis/phase3_results.csv
"""
import sys, csv
import numpy as np
from scipy import stats

DELTA = 0.0055     # target effect (observed single-run diff)
ALPHA = 0.05
POWER = 0.80

def power_paired_t(n, d, sd):
    if n < 2: return float('nan')
    df=n-1; ncp=d/(sd/np.sqrt(n)); tcrit=stats.t.ppf(1-ALPHA, df)
    return 1 - stats.nct.cdf(tcrit, df, ncp)

def required_n(d, sd, nmax=2000):
    for n in range(2, nmax+1):
        if power_paired_t(n, d, sd) >= POWER: return n
    return None

def main():
    path=sys.argv[1] if len(sys.argv)>1 else "analysis/phase3_results.csv"
    by_pair={}
    with open(path) as f:
        for r in csv.DictReader(f):
            if str(r.get("run_valid","1")).strip() not in ("1","true","True"): continue
            by_pair.setdefault(r["pair"],{})[r["arm"]]=float(r["ece"])
    d=[arms["adaptive"]-arms["disabled"] for arms in by_pair.values()
       if "disabled" in arms and "adaptive" in arms]
    d=np.array(d)
    if len(d) < 2:
        print(f"Need >=2 pilot pairs; got {len(d)}"); return
    sd = d.std(ddof=1)
    print(f"Pilot pairs: {len(d)}, d_i={np.round(d,4).tolist()}")
    print(f"Estimated sigma_d = {sd:.4f}")
    print(f"Observed mean d = {d.mean():.4f}\n")
    rn = required_n(DELTA, sd)
    p8 = power_paired_t(8, DELTA, sd)
    print(f"To detect delta={DELTA} at 80% power with this sigma_d: need n = {rn}/arm")
    print(f"Power at n=8/arm: {p8:.3f}\n")
    print("RECOMMENDATION:")
    if sd <= 0.005:
        print("  sigma_d small -> keep n=8/arm, proceed superiority. Likely publishable as 'disabled superior'.")
    elif sd <= 0.008:
        print(f"  moderate sigma_d -> raise n to ~{rn}/arm (<=15) for 80% power on superiority.")
    else:
        print("  sigma_d large -> superiority effectively unreachable.")
        print("  Run planned sample anyway; primary conclusion will go via TOST equivalence or inconclusive.")
        print(f"  (Detecting delta={DELTA} would need ~{rn}/arm — impractical.)")

if __name__=="__main__":
    main()
