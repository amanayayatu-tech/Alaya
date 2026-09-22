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
    if (waste < 6) score += 7.0;
    else if (waste < 12) score += 4.0;
    else if (waste < 20) score += 1.0;
    if (scarce >= 2 && waste > item * 0.3) score += 12;
    else if (scarce === 1 && waste > item * 0.35) score += 6;
    if (big > 0 && r >= 50 && waste <= item * 0.4) score -= 1.8 * big;
    if (med && r >= 35 && r <= 75 && waste <= 25) score -= 1.0;
    if (small && r <= 40 && waste <= 10) score -= 0.7;
    if (isVerySmall && r <= 25 && waste <= 6) score -= 1.2;
    if (r >= 90) score += 0.6;
    if (fillRatio >= 0.5) score -= 0.4 * fillRatio;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}