function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  let smallIdx = -1;
  let smallRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) { bestRem = r; best = i; }
    } else if (r < smallRem) {
      smallRem = r;
      smallIdx = i;
    }
  }
  if (best !== -1) return best;
  if (smallIdx !== -1 && item + smallRem <= 100) return -2;
  return -1;
}