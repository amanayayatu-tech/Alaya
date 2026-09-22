function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      bestRem = r;
      best = i;
    }
  }
  if (best !== -1 && bestRem - item >= 20) {
    for (let i = 0; i < remainingCapacities.length; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r < bestRem) {
        bestRem = r;
        best = i;
      }
    }
  }
  return best;
}