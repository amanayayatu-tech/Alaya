function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let bestScore = 1e9;
  const len = remainingCapacities.length;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste * 10;
    if (r <= 30) score += 4;
    else if (r <= 60) score += 2;
    else if (r <= 80) score += 1;
    if (r === item) score -= 5;
    if (score < bestScore) { bestScore = score; bestRem = r; best = i; }
    else if (score === bestScore && r < bestRem) { bestRem = r; best = i; }
  }
  return best;
}