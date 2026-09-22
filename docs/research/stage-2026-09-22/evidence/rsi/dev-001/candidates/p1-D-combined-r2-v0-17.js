function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let exactFit = -1;
  let nearFit = -1;
  let nearFitR = 101;
  let best = -1;
  let bestGap = 101;
  let bestRem = 101;
  let bestTight = false;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r === item) { exactFit = i; break; }
    if (r >= item && r - item <= 8 && r < nearFitR) { nearFit = i; nearFitR = r; }
  }
  if (exactFit !== -1) return exactFit;
  if (nearFit !== -1) return nearFit;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    const tight = gap < 20;
    let pick = false;
    if (best === -1) {
      pick = true;
    } else if (gap < bestGap) {
      pick = true;
    } else if (gap === bestGap) {
      if (tight && !bestTight) pick = true;
      else if (tight === bestTight && r < bestRem) pick = true;
    }
    if (pick) {
      best = i;
      bestGap = gap;
      bestRem = r;
      bestTight = tight;
    }
  }
  return best;
}