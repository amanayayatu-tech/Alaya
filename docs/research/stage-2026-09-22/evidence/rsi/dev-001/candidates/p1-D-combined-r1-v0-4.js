function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestGap = Infinity;
  let secondGap = Infinity;
  let totalFree = 0;
  let avg = 0;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    totalFree += c;
    if (c >= item) {
      const g = c - item;
      if (g < bestGap) { secondGap = bestGap; bestGap = g; best = i; }
      else if (g < secondGap) secondGap = g;
    }
  }
  if (best !== -1) {
    avg = totalFree / n;
    const slackRatio = bestGap / item;
    const hasCompetition = secondGap < item && (secondGap - bestGap) < 0.5 * item;
    if (hasCompetition && slackRatio < 0.5 && n >= 3) return -1;
    return best;
  }
  return -1;
}