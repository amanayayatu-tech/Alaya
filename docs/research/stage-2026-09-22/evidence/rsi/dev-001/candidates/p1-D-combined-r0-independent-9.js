function chooseBin(item, remainingCapacities) {
  let bestFit = -1;
  let bestFitRem = 101;
  let worstFit = -1;
  let worstFitRem = -1;
  let anyOpen = -1;
  let anyOpenRem = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestFitRem) { bestFitRem = r; bestFit = i; }
      if (r > worstFitRem) { worstFitRem = r; worstFit = i; }
    } else if (anyOpen === -1 && r > anyOpenRem) {
      anyOpenRem = r;
      anyOpen = i;
    }
  }
  if (bestFit !== -1) return bestFit;
  if (item <= 30 && anyOpen !== -1 && (101 - anyOpenRem) + item <= 100) return anyOpen;
  if (item <= 50 && worstFit !== -1) return worstFit;
  return -1;
}