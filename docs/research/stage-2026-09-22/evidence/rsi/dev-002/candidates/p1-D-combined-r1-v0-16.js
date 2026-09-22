function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestScore = 1e9;
  let bestRem = 101;
  let usable = 0;
  let nearFull = 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r >= item) usable++;
    if (r >= 60 && r < 100) nearFull++;
  }
  const scarce = usable <= 1 ? 2.4 : (usable <= 2 ? 1.5 : (usable <= 4 ? 0.7 : 0));
  const big = item >= 60 ? 1 : (item >= 45 ? 0.5 : 0);
  const med = item >= 25 && item < 55 ? 1 : 0;
  const small = item < 25 ? 1 : 0;
  const verySmall = item < 15 ? 1 : 0;
  const tiny = item < 8 ? 1 : 0;
  const openBonus = (nearFull >= 3 || (usable === 0 && len >= 4)) ? 1.2 : 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    const fillRatio = (100 - r) / 100;
    if (waste < 4) score += 9.5;
    else if (waste < 9) score += 5.4;
    else if (waste < 17) score += 1.7;
    if (scarce >= 2.4 && waste > item * 0.18) score += 18;
    else if (scarce >= 1.5 && waste > item * 0.24) score += 11;
    else if (scarce >= 0.7 && waste > item * 0.32) score += 4.5;
    if (big > 0 && r >= 50 && waste <= item * 0.26) score -= 3.0 * big;
    if (med && r >= 35 && r <= 75 && waste <= 17) score -= 1.7;
    if (small && r <= 40 && waste <= 7) score -= 1.2;
    if (verySmall && r <= 25 && waste <= 4) score -= 2.4;
    if (verySmall && r > 25 && r <= 50 && waste <= 4) score -= 0.7;
    if (tiny && r <= 12 && waste <= 3) score -= 2.8;
    if (tiny && r > 12 && r <= 30 && waste <= 3) score -= 1.0;
    if (r >= 92) score += 1.6;
    if (r <= 12) score += 0.9;
    if (r >= 80 && waste > 25) score += 2.5;
    if (fillRatio >= 0.4) score -= 0.7 * fillRatio;
    if (openBonus && waste > 30) score += openBonus;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}