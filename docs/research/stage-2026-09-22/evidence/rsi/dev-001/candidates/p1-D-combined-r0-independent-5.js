function chooseBin(item, remainingCapacities) {
  let best = -1;
  const n = remainingCapacities.length;
  const len = remainingCapacities;
  // Phase 1: scan all bins for an exact fit (rem waste = 0)
  for (let i = 0; i < n; i++) {
    if (len[i] === item) return i;
  }
  // Phase 2: Best-Fit -- pick bin minimizing residual rem - item
  for (let i = 0; i < n; i++) {
    if (len[i] >= item && (best === -1 || len[i] < len[best])) best = i;
  }
  return best;
}