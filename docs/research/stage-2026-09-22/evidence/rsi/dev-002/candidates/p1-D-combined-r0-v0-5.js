function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  let secondBestSlack = Infinity;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      const slack = remainingCapacities[i] - item;
      if (slack < bestSlack) { secondBestSlack = bestSlack; bestSlack = slack; best = i; }
      else if (slack < secondBestSlack) { secondBestSlack = slack; }
    }
  }
  if (best === -1) return -1;
  // Tiny items: pack as tightly as possible (best-fit) to save slack for large arrivals.
  if (item <= 18) return best;
  // Large items (>=50): use best-fit; but if best-fit is very loose AND no second bin can fit, prefer new bin.
  if (item >= 50) {
    if (bestSlack > 30 && n >= 5 && secondBestSlack > 50) return -1;
    return best;
  }
  // Medium items (25-50): if best fit leaves very large slack (>45), prefer a fuller qualifying bin (cap >= 60) to consolidate.
  if (item >= 25 && bestSlack > 45 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i]; alt = i;
      }
    }
    if (alt !== -1 && altCap >= 60 && alt !== best) return alt;
  }
  // Medium items: when best-fit is very loose AND the fit is unique, opening a new bin is cheaper.
  if (bestSlack > 55 && n >= 5 && secondBestSlack > 55) return -1;
  return best;
}