function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  const cap = 100;
  const big = item > 50;
  const small = item < 35;
  let best = -1;
  let bestRem = cap + 1;
  let bestGap = cap + 1;
  let bestBigRoom = false;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const gap = r - item;
    if (gap === 0) return i;
    const bigRoom = r >= 60;
    let pick = false;
    if (best === -1) {
      pick = true;
    } else if (gap < bestGap) {
      pick = true;
    } else if (gap === bestGap) {
      if (big && bigRoom && !bestBigRoom) pick = true;
      else if (big && !bigRoom && bestBigRoom) pick = false;
      else if (!big && !small && r < bestRem) pick = true;
      else if (!big && !small && r === bestRem && !bigRoom && bestBigRoom) pick = true;
      else if (small && !bigRoom && bestBigRoom) pick = true;
    } else if (r < bestRem) {
      if (big && bigRoom === bestBigRoom) pick = true;
      else if (!big && bigRoom === bestBigRoom) pick = true;
      else if (big && bigRoom && !bestBigRoom) pick = true;
    }
    if (pick) {
      best = i;
      bestRem = r;
      bestGap = gap;
      bestBigRoom = bigRoom;
    }
  }
  return best;
}