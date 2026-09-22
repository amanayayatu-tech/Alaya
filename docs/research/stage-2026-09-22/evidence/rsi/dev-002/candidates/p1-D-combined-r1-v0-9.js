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
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    if (waste < 12) score += 3.5;
    else if (waste < 22) score += 0.6;
    if (scarce >= 2 && waste > item * 0.35) score += 10;
    else if (scarce === 1 && waste > item * 0.4) score += 5;
    if (big > 0 && r >= 50 && waste <= item * 0.4) score -= 1.3 * big;
    if (med && r >= 35 && r <= 75 && waste <= 25) score -= 0.7;
    if (small && r <= 40 && waste <= 10) score -= 0.5;
    if (r >= 92) score += 0.5;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}