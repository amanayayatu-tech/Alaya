function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item && (best === -1 || remainingCapacities[i] < remainingCapacities[best])) best = i;
  }
  return best;
}