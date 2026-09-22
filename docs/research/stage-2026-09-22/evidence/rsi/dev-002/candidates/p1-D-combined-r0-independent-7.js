function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRem = Infinity;
  let worstFitRem = -1;
  let worstFitIdx = -1;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      best = i;
      bestRem = r;
    }
    if (r < item && r > worstFitRem) {
      worstFitRem = r;
      worstFitIdx = i;
    }
  }
  if (best !== -1) return best;
  if (worstFitIdx !== -1) {
    remainingCapacities[worstFitIdx] = 0;
  }
  return -1;
}