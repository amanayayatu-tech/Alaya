function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let n = remainingCapacities.length;
  let secondBestRem = 101;
  for (let i = 0; i < n; i++) {
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
  let gap = bestRem - item;
  if (gap <= 5) return best;
  let newBinWorth = secondBestRem < 101 ? gap <= secondBestRem - item : false;
  if (newBinWorth) return -1;
  return best;
}