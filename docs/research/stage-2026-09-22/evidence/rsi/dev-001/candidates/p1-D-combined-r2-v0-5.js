function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let bestGap = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    const gapPenalty = gap <= item ? 0 : gap - item;
    if (best === -1 || gapPenalty < bestGap || (gapPenalty === bestGap && r < bestRem)) {
      best = i;
      bestRem = r;
      bestGap = gapPenalty;
    }
  }
  return best;
}