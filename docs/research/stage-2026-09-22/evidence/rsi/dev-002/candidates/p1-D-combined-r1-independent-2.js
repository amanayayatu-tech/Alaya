function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (item > 100) return -1;
  // Perfect fit
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] === item) return i;
  }
  // Bin classes: tight (<=25), mid (26-60), loose (61-99), and almost-full (>=100? no, equal 100 means empty)
  // Actually: item size determines desired residual
  // Small item (<=30): try to find a bin where residual would be small but still >= some threshold to avoid waste
  if (item <= 30) {
    let best = -1;
    let bestResid = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        let r = remainingCapacities[i] - item;
        // avoid leaving 1-19 of waste (likely too small for next item)
        if (r < 20 && r > 0) continue;
        // prefer smallest residual above threshold, but not opening new if any
        if (r < bestResid) { bestResid = r; best = i; }
      }
    }
    if (best !== -1) return best;
    // fallback: smallest fit
    let fb = -1, fbR = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        let r = remainingCapacities[i] - item;
        if (r < fbR) { fbR = r; fb = i; }
      }
    }
    return fb;
  }
  // Medium item (31-60): prefer tight fit
  if (item <= 60) {
    let best = -1;
    let bestResid = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        let r = remainingCapacities[i] - item;
        if (r < bestResid) { bestResid = r; best = i; }
      }
    }
    if (best !== -1) return best;
    return -1;
  }
  // Large item (61-100): Best-fit, prefer tight
  let best = -1;
  let bestResid = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      let r = remainingCapacities[i] - item;
      if (r < bestResid) { bestResid = r; best = i; }
    }
  }
  return best;
}