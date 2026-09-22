function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  const small = item <= 35;
  const big = item >= 60;
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
    } else if (gap < bestGap - 1) {
      pick = true;
    } else if (gap === bestGap) {
      if (small && tight && !bestTight) pick = true;
      else if (small && !tight && bestTight) {}
      else if (big && bigRoom && !bestBigRoom) pick = true;
      else if (big && !bigRoom && bestBigRoom) {}
      else if (r < bestRem) pick = true;
    } else if (gap === bestGap - 1 && r < bestRem) {
      pick = true;
    } else if (r < bestRem - 2) {
      pick = true;
    } else if (r === bestRem && !bestTight && tight) {
      if (!big || bigRoom === bestBigRoom) pick = true;
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