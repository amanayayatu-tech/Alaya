function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const leftover = r - item;
      const score = leftover * 100 - r;
      if (best === -1 || score < bestScore) { best = i; bestScore = score; }
    }
  }
  if (best === -1) return -1;
  if (bestScore > 30) return -1;
  return best;
}