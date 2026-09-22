function chooseBin(item, remainingCapacities) {
  let best = -1, bestRem = Infinity, second = -1, secondRem = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) {
        second = best; secondRem = bestRem;
        best = i; bestRem = r;
      } else if (r < secondRem) {
        second = i; secondRem = r;
      }
    }
  }
  if (best === -1) return -1;
  // If the best fit leaves space smaller than a typical half-bin and a
  // moderately tight alternative exists, prefer the alternative.
  if (second !== -1 && bestRem - item < 20 && secondRem - item < 25 && secondRem <= bestRem + 10) {
    return second;
  }
  return best;
}