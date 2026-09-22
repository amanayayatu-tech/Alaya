function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const score = r - item;
      if (best === -1 || score < bestRem - item) {
        best = i;
        bestRem = r;
      }
      if (score === 0) break;
    }
  }
  return best;
}