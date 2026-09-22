function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestScore = 1e9;
  let bestRem = 101;
  let usable = 0;
  for (let i = 0; i < len; i++) {
    if (remainingCapacities[i] >= item) usable++;
  }
  const scarce = usable <= 1 ? 1 : 0;
  const big = item >= 60 ? 1 : (item >= 45 ? 0.5 : 0);
  const med = item >= 30 && item < 60 ? 1 : 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    const fillRatio = (100 - r) / 100;
    if (r - item < 12) score += 3;
    else if (r - item < 20) score += 0.8;
    if (scarce && waste > item * 0.35) score += 8;
    if (big > 0 && r >= 50 && waste <= item * 0.4) score -= 1.2 * big;
    if (med && r >= 40 && r <= 70) score -= 0.6;
    if (r >= 92) score += 0.4;
    score -= fillRatio * 0.5;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}