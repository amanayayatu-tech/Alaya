function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  if (item > 100) return -1;
  let best = -1;
  let bestCap = 101;
  let bestWaste = 101;
  for (let i = 0; i < len; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const waste = cap - item;
    if (waste < bestWaste) {
      bestWaste = waste;
      best = i;
      bestCap = cap;
    }
  }
  if (best === -1) return -1;
  if (bestWaste <= 25) return best;
  const totalFree = bestCap + item;
  for (let i = 0; i < len; i++) {
    if (i === best) continue;
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const fit = totalFree - Math.max(cap, item);
    if (fit >= 0 && fit <= 20) return i;
  }
  return best;
}