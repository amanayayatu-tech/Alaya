function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) { bestRem = r; best = i; }
    } else if (r > item) {
      // Near-miss bin: keep as fallback if no exact fit exists
      if (best === -1) best = -2;
    }
  }
  return best;
}