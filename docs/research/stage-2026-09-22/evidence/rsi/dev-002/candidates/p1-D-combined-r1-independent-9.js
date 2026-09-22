function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bf = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (bf === -1 || r < bf) { bf = r; best = i; }
    }
  }
  return best;
}