function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const rem = r - item;
      if (rem < bestRem) { bestRem = rem; best = i; }
    }
  }
  if (best !== -1) return best;
  // No existing bin fits: find the fullest bin to merge into if it's close.
  let fullest = -1;
  let fullestR = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] > fullestR) { fullestR = remainingCapacities[i]; fullest = i; }
  }
  return -1;
}