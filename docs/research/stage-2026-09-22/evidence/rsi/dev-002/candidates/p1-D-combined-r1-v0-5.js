function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  let bestScore = 1e9;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    // Pure Best-Fit waste (in units of item-size-equivalents).
    let score = waste;
    // Mild avoidance of opening new bins: prefer filling nearly-full bins
    // only when their waste is truly minimal; slightly favor fuller bins
    // among ties so we don't leave medium bins half-empty.
    if (r >= 70) score -= 0.15;
    else if (r <= 30) score += 0.1;
    // Tie-break by smaller remaining capacity (true best-fit).
    if (score < bestScore || (score === bestScore && r < bestRem)) {
      bestScore = score;
      bestRem = r;
      best = i;
    }
  }
  return best;
}