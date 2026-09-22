function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (item > 100) return -1;
  let best = -1;
  let bestRem = Infinity;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      bestRem = r;
      best = i;
    }
  }
  if (best !== -1) return best;
  let fullest = -1;
  let fullestRem = -1;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r > fullestRem) {
      fullestRem = r;
      fullest = i;
    }
  }
  return fullest;
}