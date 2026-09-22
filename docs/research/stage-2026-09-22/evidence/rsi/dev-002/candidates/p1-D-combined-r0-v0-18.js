function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  let secondSlack = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      const slack = remainingCapacities[i] - item;
      if (slack < bestSlack) { secondSlack = bestSlack; bestSlack = slack; best = i; }
      else if (slack < secondSlack) { secondSlack = slack; }
    }
  }
  if (best === -1) return -1;

  // Tiny items (<=18): prefer tightest fit; if none very tight, open new bin when best is loose and many bins exist.
  if (item <= 18) {
    if (bestSlack <= 6) return best;
    if (bestSlack <= 10 && n >= 3) return best;
    if (bestSlack >= 30 && n >= 3) return -1;
    return best;
  }

  // Medium items (19-55): consolidate into fuller qualifying bin only when best is very loose and second-best exists.
  if (item >= 19 && item <= 55 && bestSlack > 50 && secondSlack < bestSlack - 15 && n >= 3) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 55 && alt !== best) return alt;
  }

  // Large items (>=56): open new bin only when best slack is extreme.
  if (item >= 56 && bestSlack >= 55) return -1;

  // General: open new bin instead of extremely loose fit when several bins already exist.
  if (bestSlack >= 60 && n >= 5) return -1;

  return best;
}