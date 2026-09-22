function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRemaining = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRemaining) {
      best = i;
      bestRemaining = r;
    }
  }
  if (best === -1) return -1;
  if (bestRemaining - item <= 6) return best;
  if (item >= 55 && bestRemaining - item > 25) {
    let alt = -1;
    let altRemaining = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r >= item + 20 && r - item < altRemaining - item) {
        alt = i;
        altRemaining = r;
      }
    }
    if (alt !== -1) return alt;
  }
  if (item <= 30 && bestRemaining - item > 12) {
    let alt = -1;
    let altRemaining = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item < bestRemaining - item && r - item <= 8) {
        alt = i;
        altRemaining = r;
      }
    }
    if (alt !== -1) return alt;
  }
  return best;
}