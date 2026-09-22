function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) { bestRem = r; best = i; }
  }
  if (best === -1) return -1;
  if (bestRem - item >= 30) {
    for (let j = 0; j < remainingCapacities.length; j++) {
      if (j !== best && remainingCapacities[j] >= item) return -1;
    }
  }
  return best;
}