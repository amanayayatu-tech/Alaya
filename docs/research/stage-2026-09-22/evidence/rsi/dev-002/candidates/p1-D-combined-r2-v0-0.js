function chooseBin(item, remainingCapacities) {
  let best = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item && (best === -1 || r < remainingCapacities[best])) best = i;
  }
  return best;
}