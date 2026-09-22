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
  if (bestRemaining - item <= 5) return best;
  if (item >= 60) {
    let alt = -1;
    let altRemaining = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r < bestRemaining && r < altRemaining) {
        alt = i;
        altRemaining = r;
      }
    }
    if (alt !== -1) return alt;
  }
  if (item <= 35 && bestRemaining >= 55) {
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r < bestRemaining) {
        best = i;
        bestRemaining = r;
      }
    }
    return best;
  }
  return best;
}