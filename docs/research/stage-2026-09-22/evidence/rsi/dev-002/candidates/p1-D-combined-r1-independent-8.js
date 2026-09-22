function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      if (best === -1 || remainingCapacities[i] < remainingCapacities[best]) best = i;
    }
  }
  if (best !== -1) return best;
  let largest = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] > largest) largest = remainingCapacities[i];
  }
  if (largest > 60) return -1;
  return -1;
}