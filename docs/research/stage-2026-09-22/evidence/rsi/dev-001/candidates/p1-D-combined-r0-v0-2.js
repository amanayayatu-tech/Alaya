function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (item >= 50) {
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] === item) return i;
    }
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r < item + 25) return i;
    }
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) return i;
    }
    return -1;
  }
  let best = -1;
  let bestRemaining = Infinity;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRemaining) {
      best = i;
      bestRemaining = r;
    }
  }
  if (best !== -1 && bestRemaining - item <= 6) return best;
  if (bestRemaining >= 70 && item <= 40) return best;
  return best;
}