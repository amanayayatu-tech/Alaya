function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestScore = 1e9;
  let bestRem = 101;
  let usable = 0;
  for (let i = 0; i < len; i++) {
    if (remainingCapacities[i] >= item) usable++;
  }
  const scarce = usable <= 1 ? 2.2 : (usable <= 2 ? 1.3 : (usable <= 4 ? 0.6 : 0));
  const big = item >= 60 ? 1 : (item >= 45 ? 0.5 : 0);
  const med = item >= 25 && item < 55 ? 1 : 0;
  const small = item < 25 ? 1 : 0;
  const verySmall = item < 15 ? 1 : 0;
  const tiny = item < 8 ? 1 : 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    const fillRatio = (100 - r) / 100;
    if (waste < 4) score += 9.0;
    else if (waste < 9) score += 5.2;
    else if (waste < 17) score += 1.6;
    if (scarce >= 2.2 && waste > item * 0.2) score += 16;
    else if (scarce >= 1.3 && waste > item * 0.26) score += 10;
    else if (scarce >= 0.6 && waste > item * 0.34) score += 4.0;
    if (big > 0 && r >= 50 && waste <= item * 0.28) score -= 2.6 * big;
    if (med && r >= 35 && r <= 75 && waste <= 18) score -= 1.5;
    if (small && r <= 40 && waste <= 8) score -= 1.0;
    if (verySmall && r <= 25 && waste <= 5) score -= 2.0;
    if (verySmall && r > 25 && r <= 50 && waste <= 5) score -= 0.6;
    if (tiny && r <= 12 && waste <= 3) score -= 2.5;
    if (tiny && r > 12 && r <= 30 && waste <= 3) score -= 0.8;
    if (r >= 92) score += 1.4;
    if (r <= 12) score += 0.7;
    if (fillRatio >= 0.4) score -= 0.6 * fillRatio;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}