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
  // Threshold for opening new bin: if best fit leaves slack > 50, prefer worst-fit (fullest qualifying) to consolidate large items
  if (bestSlack > 50) {
    let worst = -1;
    let worstCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > worstCap) {
        worstCap = remainingCapacities[i]; worst = i;
      }
    }
    if (worst !== -1 && worstCap >= 70) return worst;
  }
  // Small items: ensure tight fits (slack <= 12) to preserve room for large items
  if (item <= 20) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 12) return tight;
  }
  return best;
}