function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestGap = 101;
  const n = remainingCapacities.length;
  let newBinSavings = 101;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const gap = cap - item;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
      if (gap < newBinSavings) newBinSavings = gap;
    }
  }
  return best;
}