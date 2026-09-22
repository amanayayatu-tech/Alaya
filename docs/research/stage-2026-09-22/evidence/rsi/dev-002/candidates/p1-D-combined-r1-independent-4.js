function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (item > 100) return -1;
  let best = -1;
  let bestRem = 101;
  let secondBest = -1;
  let secondRem = 101;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) {
        secondBest = best;
        secondRem = bestRem;
        best = i;
        bestRem = r;
      } else if (r < secondRem) {
        secondBest = i;
        secondRem = r;
      }
    }
  }
  if (best === -1) return -1;
  // If the best fit leaves a remainder < item and would never fit another item
  // of comparable size, prefer the second-best fit to preserve flexibility for
  // larger incoming items. Threshold based on item mean (~46.65): if the
  // residual < 30, the bin is effectively "done" so don't waste it.
  if (bestRem - item < 30 && secondBest !== -1 && secondRem - item < 60) {
    return secondBest;
  }
  return best;
}