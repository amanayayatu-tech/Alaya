function chooseBin(item, remainingCapacities) {
  let best = -1;
  let tightest = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
      const leftover = rem - item;
      if (leftover < tightest) {
        tightest = leftover;
        best = i;
      }
    }
  }
  if (best !== -1) return best;
  let fullestIdx = 0;
  let minRem = remainingCapacities[0];
  for (let i = 1; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] < minRem) {
      minRem = remainingCapacities[i];
      fullestIdx = i;
    }
  }
  return -1;
}