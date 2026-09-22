function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = (r - item) % 50;
    if (best === -1 || waste < bestRem || (waste === bestRem && r < remainingCapacities[best])) {
      best = i;
      bestRem = waste;
    }
  }
  return best;
}