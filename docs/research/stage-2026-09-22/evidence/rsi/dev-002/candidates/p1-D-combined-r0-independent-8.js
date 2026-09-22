function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = -1;
  let second = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    if (best === -1) { best = i; bestRem = r; }
    else if (r < bestRem) { second = best; best = i; bestRem = r; }
    else if (second === -1 || r < remainingCapacities[second]) { second = i; }
  }
  if (best === -1) return -1;
  const gap = bestRem - item;
  const slack = Math.max(0, 70 - item);
  if (gap > slack && second !== -1 && remainingCapacities[second] - item <= gap) {
    return -1;
  }
  return best;
}