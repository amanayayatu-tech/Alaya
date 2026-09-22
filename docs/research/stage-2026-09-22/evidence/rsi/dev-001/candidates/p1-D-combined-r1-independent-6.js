function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestRem = 101;
  let second = -1;
  let secondRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    if (r < bestRem) { second = best; secondRem = bestRem; best = i; bestRem = r; }
    else if (r < secondRem) { second = i; secondRem = r; }
  }
  if (best === -1) return -1;
  if (second === -1) return best;
  if (n >= 6 && bestRem - secondRem >= 6) return second;
  return best;
}