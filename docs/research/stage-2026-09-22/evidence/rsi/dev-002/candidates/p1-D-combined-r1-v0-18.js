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
    if (r >= 50 && r < 100) nearFull++;
  }
  const scarce = usable <= 1 ? 2.4 : (usable <= 2 ? 1.6 : (usable <= 4 ? 0.7 : 0));
  const big = item >= 60 ? 1 : (item >= 45 ? 0.5 : 0);
  const med = item >= 25 && item < 55 ? 1 : 0;
  const small = item < 25 ? 1 : 0;
  const verySmall = item < 15 ? 1 : 0;
  const tiny = item < 8 ? 1 : 0;
  const openBonus = (nearFull >= 4 || (usable === 0 && len >= 4)) ? 0.8 : 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    const fillRatio = (100 - r) / 100;
    if (waste < 4) score += 9.5;
    else if (waste < 9) score += 5.2;
    else if (waste < 17) score += 1.5;
    if (scarce >= 2.4 && waste > item * 0.20) score += 20;
    else if (scarce >= 1.6 && waste > item * 0.24) score += 12;
    else if (scarce >= 0.7 && waste > item * 0.32) score += 4.5;
    if (big > 0 && r >= 50 && waste <= item * 0.26) score -= 3.2 * big;
    if (med && r >= 35 && r <= 75 && waste <= 17) score -= 2.1;
    if (small && r <= 38 && waste <= 7) score -= 1.4;
    if (verySmall && r <= 22 && waste <= 3) score -= 2.8;
    if (verySmall && r > 22 && r <= 48 && waste <= 3) score -= 0.9;
    if (tiny && r <= 10 && waste <= 2) score -= 3.2;
    if (tiny && r > 10 && r <= 28 && waste <= 2) score -= 1.2;
    if (r >= 90) score += 1.8;
    if (r <= 10) score += 1.0;
    if (r >= 78 && waste > 24) score += 3.2;
    if (fillRatio >= 0.4) score -= 0.8 * fillRatio;
    if (openBonus && waste > 30) score += openBonus;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}