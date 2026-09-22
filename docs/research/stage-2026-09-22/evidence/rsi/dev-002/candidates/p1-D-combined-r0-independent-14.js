function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let secondBestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) {
        secondBestRem = bestRem;
        bestRem = r;
        best = i;
      } else if (r < secondBestRem) {
        secondBestRem = r;
      }
    }
  }
  if (best === -1) return -1;
  if (remainingCapacities.length >= 2 && secondBestRem < 101) {
    let remAfter = bestRem - item;
    if (remAfter > secondBestRem) return -1;
  }
  return best;
}