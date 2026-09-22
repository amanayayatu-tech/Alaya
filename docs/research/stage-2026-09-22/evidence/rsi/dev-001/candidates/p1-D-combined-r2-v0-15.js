function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestGap = 101;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    if (gap === 0) return i;
    if (gap < bestGap || (gap === bestGap && r < bestRem)) {
      best = i;
      bestGap = gap;
      bestRem = r;
    }
  }
  if (best !== -1) return best;
  let tightest = -1;
  let tightestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r > item) continue;
    const gap = item - r;
    if (gap < item - tightestRem || tightest === -1) {
      tightest = i;
      tightestRem = r;
    }
  }
  return tightest;
}