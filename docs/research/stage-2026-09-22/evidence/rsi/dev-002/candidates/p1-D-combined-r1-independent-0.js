function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      bestRem = r;
      best = i;
    }
  }
  if (best !== -1) return best;
  let smallest = -1;
  let smallestRem = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < smallestRem) {
      smallestRem = r;
      smallest = i;
    }
  }
  if (smallest !== -1 && smallestRem >= item * 0.5) return smallest;
  return -1;
}