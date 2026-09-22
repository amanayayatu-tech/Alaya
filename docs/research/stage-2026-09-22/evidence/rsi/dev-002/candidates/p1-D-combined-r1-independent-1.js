function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  let n = remainingCapacities.length;
  if (n === 0) return -1;
  // Threshold for very small residual fragments: opening a new bin is cheaper than wasting a usable slot.
  if (item <= 12 && n > 1) {
    let tightCount = 0;
    let tightBest = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      let r = remainingCapacities[i];
      if (r >= item) {
        tightCount++;
        if (r - item < tightSlack) {
          tightSlack = r - item;
          tightBest = i;
        }
      }
    }
    // If at least 2 bins can still host this item, do NOT consume a near-full bin: open a new one.
    if (tightCount >= 2) return -1;
    if (tightCount === 1) return tightBest;
  }
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    let slack = r - item;
    if (slack >= 0 && slack < bestSlack) {
      bestSlack = slack;
      best = i;
    }
  }
  return best;
}