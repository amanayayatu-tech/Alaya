function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  let tightCount = 0;
  let smallItem = item < 25;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
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
  if (tightCount >= 4 && slackRatio < 0.2 && competitive) return -1;
  if (tightCount >= 3 && slackRatio > 0.6 && secondGap < 0.3 * item && bestGap > 2 * secondGap) return -1;
  if (smallItem && tightCount >= 3 && slackRatio < 0.15) return -1;
  return best;
}