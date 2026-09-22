function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const g = c - item;
      if (g < bestGap) { secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) secondGap = g;
    }
  }
  if (best === -1) return -1;
  const slackRatio = bestGap / item;
  const competitive = secondGap < 2 * item && (secondGap - bestGap) < 0.4 * item;
  if (slackRatio < 0.3 && competitive && n >= 3) return -1;
  if (slackRatio > 0.6 && bestGap > 2 * secondGap && secondGap < 0.3 * item && n >= 3) return -1;
  return best;
}