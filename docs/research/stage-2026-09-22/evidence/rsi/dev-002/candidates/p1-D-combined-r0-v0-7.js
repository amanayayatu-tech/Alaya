function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  let secondBestSlack = Infinity;
  let sumSlack = 0;
  let countSlack = 0;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const slack = cap - item;
      if (slack < bestSlack) { secondBestSlack = bestSlack; bestSlack = slack; best = i; }
      else if (slack < secondBestSlack) { secondBestSlack = slack; }
      sumSlack += slack;
      countSlack++;
    }
  }
  if (best === -1) return -1;
  if (item <= 18) {
    if (bestSlack <= 8) return best;
    if (n >= 4 && bestSlack <= 18) return best;
    return best;
  }
  if (item >= 50) {
    if (bestSlack > 35 && n >= 5 && secondBestSlack > 50) return -1;
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
  const avgSlack = countSlack > 0 ? sumSlack / countSlack : 0;
  if (bestSlack > 55 && n >= 5 && secondBestSlack > 55) return -1;
  if (bestSlack > 40 && n >= 6 && bestSlack > avgSlack * 1.6) return -1;
  return best;
}