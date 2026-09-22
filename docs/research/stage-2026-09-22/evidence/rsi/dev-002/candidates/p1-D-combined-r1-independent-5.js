function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bf = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    if (bf === -1 || r < remainingCapacities[bf]) bf = i;
    if (r >= item * 3) {
      if (best === -1 || r < remainingCapacities[best]) best = i;
    }
  }
  if (best !== -1) return best;
  return bf;
}