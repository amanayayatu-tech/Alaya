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
  // Small items (<=22): prefer tight fits with slack <= 10 to preserve room for large items.
  if (item <= 22) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 10) return tight;
  }
  // Medium items (23-49): consolidate into fuller bins when best-fit is loose and many bins exist.
  if (item >= 23 && item <= 49 && bestSlack > 40 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 55 && alt !== best) return alt;
  }
  // Large items (>=50): best-fit is reliable; avoid very loose fits that fragment bins.
  if (item >= 50 && bestSlack > 45 && n >= 5) return -1;
  // Generic: when many bins exist and best-fit slack is large, open a new bin.
  if (bestSlack > 55 && n >= 5) return -1;
  return best;
}