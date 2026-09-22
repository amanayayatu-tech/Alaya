function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) { best = i; bestRem = r; }
  }
  if (best !== -1) return best;
  let smallest = -1;
  let smallestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r > item && r < smallestRem) { smallest = i; smallestRem = r; }
  }
  return smallest;
}