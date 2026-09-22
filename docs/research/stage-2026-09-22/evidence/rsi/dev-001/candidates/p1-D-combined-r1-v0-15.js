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
  // Open a new bin only when the best-fit gap is very small (<=3) AND
  // the runner-up gap is close (<= bestGap + 3), and at least 2 bins fit.
  // This narrowly protects near-full bins without over-opening.
  if (tightCount >= 2 && bestGap <= 3 && secondGap <= bestGap + 3) return -1;
  return best;
}