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
  if (item <= 18) return best;
  if (item >= 50) {
    if (bestSlack > 30 && n >= 5 && secondBestSlack > 50) return -1;
    return best;
  }
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
  if (bestSlack > 55 && n >= 5 && secondBestSlack > 55) return -1;
  return best;
}