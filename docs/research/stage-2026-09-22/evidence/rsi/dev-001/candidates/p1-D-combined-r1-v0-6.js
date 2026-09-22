function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  let thirdGap = Infinity;
  let tightCount = 0;
  let sumTightGap = 0;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const g = c - item;
      tightCount++;
      sumTightGap += g;
      if (g < bestGap) { thirdGap = secondGap; secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) { thirdGap = secondGap; secondGap = g; }
      else if (g < thirdGap) thirdGap = g;
    }
  }
  if (best === -1) return -1;
  const slackRatio = bestGap / item;
  const spread = secondGap - bestGap;
  const competitive = secondGap < 1.5 * item;
  const crowded = tightCount >= 3 && thirdGap < 2 * item;
  if (slackRatio < 0.25 && competitive && spread < 0.3 * item && n >= 3) return -1;
  if (slackRatio > 0.55 && secondGap < 0.35 * item && bestGap > 1.8 * secondGap && crowded) return -1;
  return best;
}