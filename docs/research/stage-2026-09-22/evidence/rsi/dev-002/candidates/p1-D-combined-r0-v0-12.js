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
  // Tiny items (<=18): very tight fits (slack<=8) preserve room; among them pick tightest.
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
  // Small items (19-30): tight-fit if available (slack<=12), else best-fit.
  if (item >= 19 && item <= 30) {
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
  // Medium items (31-55): consolidate into fuller bins when best-fit slack is large.
  if (item >= 31 && item <= 55 && bestSlack > 38 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 55 && alt !== best) return alt;
  }
  // Avoid very loose fits that fragment bins; open new bin instead.
  if (bestSlack > 55 && n >= 5) return -1;
  if (item >= 50 && bestSlack > 42 && n >= 5) return -1;
  return best;
}