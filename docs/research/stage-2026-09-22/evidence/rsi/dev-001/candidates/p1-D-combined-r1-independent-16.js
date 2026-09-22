function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = 101;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      if (c < bestCap) { bestCap = c; best = i; }
    } else if (c > 0 && c < bestCap - 1) {
      const waste = c;
      if (waste < bestCap - 1) { /* no-op placeholder */ }
    }
  }
  return best;
}