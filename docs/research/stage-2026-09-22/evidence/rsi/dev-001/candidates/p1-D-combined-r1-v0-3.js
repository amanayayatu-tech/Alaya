function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let tightBest = -1;
  let tightGap = Infinity;
  let looseBest = -1;
  let looseGap = Infinity;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const g = c - item;
      if (g < tightGap) { tightGap = g; tightBest = i; }
    } else {
      const g = item - c;
      if (g < looseGap) { looseGap = g; looseBest = i; }
    }
  }
  if (tightBest !== -1) {
    if (tightGap <= 0.25 * item) return tightBest;
    if (tightGap <= item && n >= 4) {
      let bestGap = Infinity, idx = -1;
      for (let i = 0; i < n; i++) {
        if (remainingCapacities[i] >= item) {
          const g = remainingCapacities[i] - item;
          if (g < bestGap) { bestGap = g; idx = i; }
        }
      }
      return idx === -1 ? tightBest : idx;
    }
    return tightBest;
  }
  if (looseBest !== -1 && looseGap <= 0.20 * item) return looseBest;
  return -1;
}