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
  // Medium items (25-50): if best fit leaves very large slack (>45), prefer a fuller qualifying bin (cap >= 60) to consolidate.
  if (item >= 25 && item <= 50 && bestSlack > 45 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 60 && alt !== best) return alt;
  }
  // Tiny items (<=18): prefer the tightest fit with slack <= 8 to preserve capacity for large items.
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
  }
  // When many bins exist and best-fit slack is moderate, opening a new bin can be cheaper than a loose fit.
  if (bestSlack > 55 && n >= 5) return -1;
  return best;
}