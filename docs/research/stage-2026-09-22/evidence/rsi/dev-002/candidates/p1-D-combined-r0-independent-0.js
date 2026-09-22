function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) {
        bestRem = r;
        best = i;
      } else if (r === bestRem && r - item > (remainingCapacities[best] - item)) {
        best = i;
      }
    }
  }
  if (best === -1) return -1;
  const slack = remainingCapacities[best] - item;
  if (slack >= 60) return -1;
  if (slack >= 40 && item <= 30) return -1;
  return best;
}