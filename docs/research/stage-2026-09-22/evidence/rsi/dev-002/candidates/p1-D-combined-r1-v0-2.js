function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) { bestRem = r; best = i; }
      else if (r === bestRem && (r & 1) && (bestRem & 1) !== 1) { best = i; }
    }
  }
  return best;
}