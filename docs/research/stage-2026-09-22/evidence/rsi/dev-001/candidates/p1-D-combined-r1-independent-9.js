function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = -1;
  let n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (best === -1) { best = i; bestRem = r; }
      else {
        let d = r - item;
        let bd = bestRem - item;
        if (d > bd && d >= 30) { best = i; bestRem = r; }
        else if (d < bd) { best = i; bestRem = r; }
      }
    }
  }
  if (best === -1) return -1;
  let slack = bestRem - item;
  if (slack < 20) return best;
  let totalSlack = 0;
  for (let i = 0; i < n; i++) totalSlack += remainingCapacities[i];
  if (totalSlack > 80) return -1;
  return best;
}