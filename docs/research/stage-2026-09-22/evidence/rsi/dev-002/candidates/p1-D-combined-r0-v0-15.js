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
  // Tiny items (<=15): tight fit if slack <= 7.
  if (item <= 15) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 7) return tight;
  }
  // Small items (16-25): tight fit if slack <= 9.
  if (item >= 16 && item <= 25) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 9) return tight;
  }
  // Medium items (26-50): consolidate into fuller qualifying bin if best-fit slack is large.
  if (item >= 26 && item <= 50 && bestSlack > 35 && n >= 3) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 50 && alt !== best) return alt;
  }
  // Avoid very loose fits when enough bins exist.
  if (bestSlack > 50 && n >= 5) return -1;
  // Large items (>=70): open new bin if best-fit slack is substantial.
  if (item >= 70 && bestSlack > 20 && n >= 4) return -1;
  return best;
}