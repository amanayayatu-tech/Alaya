function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c >= item && c < bestCap) { bestCap = c; best = i; }
  }
  return best;
}