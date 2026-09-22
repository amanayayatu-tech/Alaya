function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  const cap = 100;
  const itemGap = cap - item;
  let best = -1;
  let bestRem = cap + 1;
  let bestFitTie = false;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    if (gap === 0) return i;
    if (best === -1) {
      best = i;
      bestRem = r;
      bestFitTie = gap >= itemGap;
      continue;
    }
    if (r < bestRem) {
      best = i;
      bestRem = r;
      bestFitTie = gap >= itemGap;
    } else if (r === bestRem) {
      const tieGap = gap >= itemGap;
      if (tieGap && !bestFitTie) {
        best = i;
        bestFitTie = true;
      } else if (!tieGap && bestFitTie) {
        best = i;
        bestFitTie = false;
      }
    }
  }
  return best;
}