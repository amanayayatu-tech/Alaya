function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  // First pass: find best-fit (tightest qualifying).
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      const slack = remainingCapacities[i] - item;
      if (slack < bestSlack) { bestSlack = slack; best = i; }
    }
  }
  if (best === -1) return -1;

  // Tiny items: keep very tight fits (<=6) to preserve space for large items.
  if (item <= 18) {
    if (bestSlack <= 6) return best;
    // Search for a tightest fit still <=8.
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tightSlack <= 8) return tight;
    // No tight slot: open new bin (saves large-item capacity).
    if (bestSlack >= 25) return -1;
    return best;
  }

  // Medium items (19-55): prefer consolidating into a fuller qualifying bin when slack is very large.
  if (item <= 55 && bestSlack > 40 && n >= 3) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 55 && altCap !== remainingCapacities[best]) return alt;
  }

  // Large items (>=56): open new bin when best slack is huge to avoid stranding capacity.
  if (item >= 56 && bestSlack >= 45) return -1;

  // General: opening a new bin is cheaper than a very loose fit when many bins exist.
  if (bestSlack >= 55 && n >= 5) return -1;
  return best;
}