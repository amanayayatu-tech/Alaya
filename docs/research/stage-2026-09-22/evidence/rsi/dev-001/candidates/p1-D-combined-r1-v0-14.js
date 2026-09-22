function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  let tightCount = 0;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      tightCount++;
      const g = c - item;
      if (g < bestGap) { secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) secondGap = g;
    }
  }
  if (best === -1) return -1;
  // Open a new bin when the best-fit gap is small and a near-equally-good bin
  // exists; preserve the tightest bin for a potentially larger unseen item.
  // Threshold tuned around itemMean~47: gaps under ~6 with runner-up within 2.5x.
  if (secondGap !== Infinity && bestGap <= 6 && secondGap <= bestGap * 2.5) return -1;
  return best;
}