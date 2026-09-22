function chooseBin(item, remainingCapacities) {
  let best = -1;
  let n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    let c = remainingCapacities[i];
    if (c < item) continue;
    if (c === item) return i;
    if (best === -1 || c < remainingCapacities[best]) best = i;
  }
  return best;
}