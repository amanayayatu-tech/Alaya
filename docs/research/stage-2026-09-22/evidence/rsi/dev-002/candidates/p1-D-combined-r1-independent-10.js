function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      bestRem = r;
      best = i;
    }
  }
  return best;
}