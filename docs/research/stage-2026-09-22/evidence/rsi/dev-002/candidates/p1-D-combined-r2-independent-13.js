function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (item <= 0) return -1;
  let best = -1, bestRem = 101;
  let smallRem = 101, smallIdx = -1;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) { bestRem = r; best = i; }
    } else if (r > 0 && r < smallRem) {
      smallRem = r; smallIdx = i;
    }
  }
  if (best !== -1) return best;
  return smallIdx;
}