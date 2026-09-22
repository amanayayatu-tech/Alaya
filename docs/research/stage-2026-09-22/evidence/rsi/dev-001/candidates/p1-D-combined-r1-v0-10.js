function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  let tightCount = 0;
  let tightestCap = Infinity;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c < tightestCap) tightestCap = c;
    if (c >= item) {
      tightCount++;
      const g = c - item;
      if (g < bestGap) { secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) secondGap = g;
    }
  }
  if (best === -1) return -1;
  const slackRatio = bestGap / item;
  const competitive = secondGap < 1.2 * item;
  // avoid opening new bin when many bins fit and best fit is very tight
  if (tightCount >= 4 && slackRatio < 0.2 && competitive) return -1;
  // avoid opening new bin when a slightly looser bin also fits and gap is large
  if (tightCount >= 3 && slackRatio > 0.6 && secondGap < 0.3 * item && bestGap > 2 * secondGap) return -1;
  // hard cap: refuse to place if remaining capacity would drop below a safety floor
  if (remainingCapacities[best] - item < 3) return -1;
  return best;
}