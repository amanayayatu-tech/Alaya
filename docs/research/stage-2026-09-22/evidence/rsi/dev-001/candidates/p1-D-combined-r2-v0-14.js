function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestGap = 101;
  let bestRem = 101;
  let bestTight = false;
  let bestBigRoom = false;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    if (gap === 0) return i;
    const tight = gap < 25;
    const bigRoom = r >= 60;
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
      bestBigRoom = bigRoom;
    }
  }
  return best;
}