function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 100;
  let n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (best === -1 || r < bestRem) {
        best = i;
        bestRem = r;
      }
    }
  }
  return best;
}