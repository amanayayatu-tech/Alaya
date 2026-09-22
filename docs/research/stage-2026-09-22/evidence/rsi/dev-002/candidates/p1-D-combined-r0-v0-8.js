function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  let secondBestSlack = Infinity;
  let thirdBestSlack = Infinity;
  let sumSlack = 0;
  let countSlack = 0;
  let fullBinCap = -1;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const slack = cap - item;
      if (slack < bestSlack) {
        thirdBestSlack = secondBestSlack;
        secondBestSlack = bestSlack;
        bestSlack = slack;
        best = i;
      } else if (slack < secondBestSlack) {
        thirdBestSlack = secondBestSlack;
        secondBestSlack = slack;
      } else if (slack < thirdBestSlack) {
        thirdBestSlack = slack;
      }
      sumSlack += slack;
      countSlack++;
      if (cap > fullBinCap) fullBinCap = cap;
    }
  }
  if (best === -1) return -1;
  const avgSlack = countSlack > 0 ? sumSlack / countSlack : 0;
  // Tiny items: tight best-fit.
  if (item <= 18) {
    if (bestSlack <= 10) return best;
    if (n >= 5 && bestSlack > 30 && thirdBestSlack > 30) return -1;
    return best;
  }
  // Large items: avoid loose fits; if slack is huge and no tight alt, open new bin.
  if (item >= 50) {
    if (bestSlack > 30 && n >= 4 && secondBestSlack > 40) return -1;
    if (bestSlack > 25 && n >= 6 && bestSlack > avgSlack * 1.5) return -1;
    return best;
  }
  // Medium items (25-50): consolidate into fuller qualifying bin when best-fit is loose.
  if (item >= 25 && bestSlack > 45 && n >= 4) {
    let alt = -1;
    let altCap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item && remainingCapacities[i] > altCap) {
        altCap = remainingCapacities[i];
        alt = i;
      }
    }
    if (alt !== -1 && altCap >= 60 && alt !== best) return alt;
  }
  // Loose fit heuristic: open new bin if slack is an outlier vs other qualifying slacks.
  if (bestSlack > 55 && n >= 5 && secondBestSlack > 55) return -1;
  if (bestSlack > 40 && n >= 6 && bestSlack > avgSlack * 1.7) return -1;
  return best;
}