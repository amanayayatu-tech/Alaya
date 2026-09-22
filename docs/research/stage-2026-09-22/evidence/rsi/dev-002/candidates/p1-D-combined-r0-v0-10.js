function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      const slack = remainingCapacities[i] - item;
      if (slack < bestSlack) { bestSlack = slack; best = i; }
    }
  }
  if (best === -1) return -1;
  // Tiny items: pack into the tightest qualifying bin (slack <= 8) to preserve capacity.
  if (item <= 18) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 8) return tight;
    return best;
  }
  // Small-medium items (19-34): consolidate into fuller bins to reduce bin count.
  if (item >= 19 && item <= 34 && bestSlack > 25) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = remainingCapacities[i];
      if (c >= item && c > altCap) { altCap = c; alt = i; }
    }
    if (alt !== -1 && altCap >= 50 && altCap - item <= 45 && altCap > remainingCapacities[best]) return alt;
  }
  // Medium-large items (35-50): consolidate when slack is large and a fuller bin exists.
  if (item >= 35 && item <= 50 && bestSlack > 40 && n >= 3) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = remainingCapacities[i];
      if (c >= item && c > altCap) { altCap = c; alt = i; }
    }
    if (alt !== -1 && altCap >= 65 && altCap - item <= 50 && alt !== best) return alt;
  }
  // Large items (>=51): avoid overly tight fits that strand small space; use next-best or open new.
  if (item >= 51 && bestSlack <= 7 && n >= 3) {
    let second = -1;
    let secondSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack > bestSlack && slack < secondSlack) { secondSlack = slack; second = i; }
      }
    }
    if (second !== -1 && secondSlack <= 30) return second;
    if (bestSlack <= 7) return -1;
  }
  // Very loose best-fit: opening a new bin may be cheaper.
  if (bestSlack > 55 && n >= 5) return -1;
  return best;
}