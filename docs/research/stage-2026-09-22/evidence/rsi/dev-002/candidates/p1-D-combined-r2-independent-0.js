function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1, bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      best = i;
      bestRem = r;
      if (r === item) break;
    }
  }
  return best;
}