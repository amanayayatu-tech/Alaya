function chooseBin(item, remainingCapacities) {
  let best = -1, bestSpace = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r - item < bestSpace) {
      bestSpace = r - item;
      best = i;
    }
  }
  return best;
}