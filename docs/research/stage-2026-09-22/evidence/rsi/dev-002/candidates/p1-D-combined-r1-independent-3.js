function chooseBin(item, remainingCapacities) {
  let bestIdx = -1;
  let bestRem = Infinity;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
      const left = rem - item;
      if (left < bestRem) {
        bestRem = left;
        bestIdx = i;
      }
    }
  }
  if (bestIdx !== -1) return bestIdx;
  let minIdx = -1;
  let minRem = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] < minRem) {
      minRem = remainingCapacities[i];
      minIdx = i;
    }
  }
  const CAP = 100;
  if (minIdx !== -1 && (CAP - minRem) < item * 0.85) return minIdx;
  return -1;
}