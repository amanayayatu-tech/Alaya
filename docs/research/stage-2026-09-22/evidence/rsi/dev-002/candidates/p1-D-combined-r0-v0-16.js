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
  // Tiny items (<=15): tight fit if slack <= 7, else best.
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
    return best;
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
    return best;
  }
  // Medium items (26-50): consolidate if best fit is loose, else best.
  if (item >= 26 && item <= 50) {
    if (bestSlack > 35 && n >= 3) {
      let alt = -1;
      let altCap = -Infinity;
      for (let i = 0; i < n; i++) {
        if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
          altCap = remainingCapacities[i]; alt = i;
        }
      }
      if (alt !== -1 && altCap >= 50 && alt !== best) return alt;
    }
    if (bestSlack > 55 && n >= 5) return -1;
    return best;
  }
  // Large items (>=70): prefer tight fit; open new bin when fit is loose.
  if (item >= 70) {
    let tight = -1;
    let tightSlack = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        if (slack < tightSlack) { tightSlack = slack; tight = i; }
      }
    }
    if (tight !== -1 && tightSlack <= 15) return tight;
    if (bestSlack > 20 && n >= 4) return -1;
    return best;
  }
  // Mid-large items (51-69): standard best fit, avoid very loose fits.
  if (bestSlack > 45 && n >= 5) return -1;
  return best;
}