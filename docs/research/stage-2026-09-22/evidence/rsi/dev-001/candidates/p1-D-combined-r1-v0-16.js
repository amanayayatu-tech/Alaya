function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const g = c - item;
      if (g < bestGap) { secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) secondGap = g;
    }
  }
  if (best === -1) return -1;
  // Open a new bin when best-fit wastes little (<=2) AND the runner-up
  // gap is close (ratio<=2), preserving the near-full bin for larger items.
  if (secondGap !== Infinity && bestGap <= 2 && secondGap <= bestGap * 2) return -1;
  return best;
}