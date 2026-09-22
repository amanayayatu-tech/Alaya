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
  // Worst-fit: if many bins exist and the best fit leaves large slack, prefer fuller bin
  if (n >= 6 && item >= 30 && bestSlack >= 30) {
    let worst = -1;
    let worstCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > worstCap) {
        worstCap = remainingCapacities[i]; worst = i;
      }
    }
    if (worst !== -1 && worstCap >= 60) return worst;
  }
  // Small items: prefer tight fits to leave room for large items
  if (item <= 15 && n >= 4) {
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
  return best;
}