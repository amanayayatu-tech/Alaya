function chooseBin(item, remainingCapacities) {
  let len = remainingCapacities.length;
  if (len === 0) return -1;
  let bestFit = -1;
  let bestRemaining = 0;
  for (let i = 0; i < len; i++) {
    let cap = remainingCapacities[i];
    if (cap >= item) {
      let rem = cap - item;
      if (bestFit === -1 || rem < bestRemaining) {
        bestFit = i;
        bestRemaining = rem;
      }
    }
  }
  return bestFit;
}