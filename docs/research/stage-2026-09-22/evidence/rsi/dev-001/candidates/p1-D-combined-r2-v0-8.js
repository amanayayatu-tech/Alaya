function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  const cap = 100;
  const itemGap = cap - item;
  const ref = item < 30 ? 30 : (item > 60 ? 60 : item);
  let best = -1;
  let bestRem = cap + 1;
  let bestScore = -1;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    if (gap === 0) return i;
    let s = gap;
    if (gap < ref) s -= (ref - gap) * 2;
    else if (gap < item) s += (item - gap);
    if (best === -1 || s > bestScore || (s === bestScore && r < bestRem)) {
      best = i;
      bestRem = r;
      bestScore = s;
    }
  }
  return best;
}