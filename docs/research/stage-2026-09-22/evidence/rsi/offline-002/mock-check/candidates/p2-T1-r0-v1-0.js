function chooseBin(item, remainingCapacities) {
  let best = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item && (best === -1 || remainingCapacities[i] < remainingCapacities[best])) best = i;
  }
  return best;
}