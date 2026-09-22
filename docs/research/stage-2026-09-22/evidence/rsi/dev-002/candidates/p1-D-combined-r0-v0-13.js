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
  // Tiny items (<=18): tightest fit if slack <= 8, else best-fit.
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
  // Small items (19-28): tight-fit if slack <= 10.
  if (item >= 19 && item <= 28) {
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
  // Medium items (29-50): consolidate into fuller bin when best-fit slack is large.
  if (item >= 29 && item <= 50 && bestSlack > 40 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 50 && alt !== best) return alt;
  }
  // Open a new bin instead of very loose fits to reduce fragmentation.
  if (bestSlack > 55 && n >= 5) return -1;
  if (item >= 50 && bestSlack > 42 && n >= 5) return -1;
  // Large items (>=70): avoid loose fits that waste capacity.
  if (item >= 70 && bestSlack > 30 && n >= 4) return -1;
  return best;
}