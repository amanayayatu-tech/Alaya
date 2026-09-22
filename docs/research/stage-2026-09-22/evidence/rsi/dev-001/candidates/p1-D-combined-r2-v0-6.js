function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestRem = 101;
  let bestScore = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    let score;
    if (gap <= item) score = gap * 2;
    else score = gap * 2 + (gap - item);
    if (best === -1 || score < bestScore || (score === bestScore && r < bestRem)) {
      best = i;
      bestRem = r;
      bestScore = score;
    }
    if (gap === 0) return i;
  }
  return best;
}