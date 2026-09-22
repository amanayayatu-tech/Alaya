function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestGap = Infinity;
  const n = remainingCapacities.length;
  let emptyCount = 0;
  let totalSlack = 0;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const gap = r - item;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    } else if (r === 100) {
      emptyCount++;
    } else {
      totalSlack += r;
    }
  }
  if (best !== -1) return best;
  return -1;
}