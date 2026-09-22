function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = 101;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item && c < bestCap) {
      bestCap = c;
      best = i;
    }
  }
  if (best !== -1) return best;
  let openIdx = -1;
  let openCap = -1;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c > openCap) {
      openCap = c;
      openIdx = i;
    }
  }
  return openIdx;
}