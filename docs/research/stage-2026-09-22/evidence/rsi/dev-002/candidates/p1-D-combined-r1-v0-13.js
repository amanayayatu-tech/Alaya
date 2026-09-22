function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestScore = 1e9;
  let bestRem = 101;
  let usable = 0;
  for (let i = 0; i < len; i++) {
    if (remainingCapacities[i] >= item) usable++;
  }
  const scarce = usable <= 1 ? 2 : (usable <= 3 ? 1 : 0);
  const big = item >= 60 ? 1 : (item >= 45 ? 0.5 : 0);
  const med = item >= 25 && item < 55 ? 1 : 0;
  const small = item < 25 ? 1 : 0;
  const isVerySmall = item < 15 ? 1 : 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    const fillRatio = (100 - r) / 100;
    if (waste < 5) score += 8.5;
    else if (waste < 10) score += 5.0;
    else if (waste < 18) score += 1.5;
    if (scarce >= 2 && waste > item * 0.28) score += 13;
    else if (scarce === 1 && waste > item * 0.33) score += 6.5;
    if (big > 0 && r >= 50 && waste <= item * 0.35) score -= 2.0 * big;
    if (med && r >= 35 && r <= 75 && waste <= 22) score -= 1.2;
    if (small && r <= 40 && waste <= 8) score -= 0.8;
    if (isVerySmall && r <= 25 && waste <= 5) score -= 1.4;
    if (r >= 92) score += 1.0;
    if (fillRatio >= 0.5) score -= 0.45 * fillRatio;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}