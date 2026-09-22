function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) { bestRem = r; best = i; }
  }
  if (best !== -1) return best;
  let bestGap2 = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    const gap = item - r;
    if (gap < bestGap2) { bestGap2 = gap; best = i; }
  }
  return best;
}