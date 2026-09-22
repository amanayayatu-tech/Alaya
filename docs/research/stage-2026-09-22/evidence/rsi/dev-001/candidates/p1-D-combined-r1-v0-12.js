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
  // Open a new one when best fit is much worse than the runner-up; the
  // runner-up will absorb this item more efficiently and free the best slot
  // for a larger upcoming item we cannot see.
  if (secondGap !== Infinity && bestGap >= secondGap * 2 && tightCount >= 2) return -1;
  return best;
}