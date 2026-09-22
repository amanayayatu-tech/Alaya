function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const score = r - item;
    if (best === -1 || score < bestRem - item) {
      best = i;
      bestRem = r;
    }
    if (score === 0) break;
  }
  return best;
}