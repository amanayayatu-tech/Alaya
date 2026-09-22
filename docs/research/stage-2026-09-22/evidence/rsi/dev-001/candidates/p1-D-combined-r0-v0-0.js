function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRemaining = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRemaining) {
      best = i;
      bestRemaining = r;
    }
  }
  return best;
}