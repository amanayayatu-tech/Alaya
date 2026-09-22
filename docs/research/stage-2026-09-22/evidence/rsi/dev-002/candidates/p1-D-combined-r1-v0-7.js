function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestScore = 1e9;
  let bestRem = 101;
  // Aggregate signal: how many bins can hold this item, and total slack.
  let usable = 0;
  let totalRem = 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    totalRem += r;
    if (r >= item) usable++;
  }
  // Opening pressure: scarce fit -> penalize wasting space in a usable bin.
  const scarce = usable <= 1 ? 1 : 0;
  // Item-size pressure: large items benefit from filling bins aggressively.
  const big = item >= 60 ? 1 : (item >= 40 ? 0.5 : 0);
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let score = waste;
    // Avoid leaving very small, hard-to-fill remainders (under 15).
    if (r - item < 15) score += 2;
    // When few bins can take the item, avoid large gaps (waste > 0.4*item).
    if (scarce && waste > item * 0.4) score += 6;
    // For large items, prefer fuller bins to reduce new-bin churn.
    if (big > 0 && r >= 50 && waste <= item * 0.3) score -= 0.5 * big;
    // Mildly discourage fitting into a barely-empty bin (>=90):
    // its residual is too small for typical follow-up items.
    if (r >= 90) score += 0.5;
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}