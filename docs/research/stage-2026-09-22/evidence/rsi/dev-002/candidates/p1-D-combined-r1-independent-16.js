function chooseBin(item, remainingCapacities) {
  let best = -1;
  let tightest = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      if (c < tightest) { tightest = c; best = i; }
    }
  }
  if (best !== -1) return best;
  let worstIdx = -1;
  let worstCap = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c > item && c > worstCap) { worstCap = c; worstIdx = i; }
  }
  return worstIdx;
}