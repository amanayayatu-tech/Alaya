function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const slack = r - item;
      const score = slack + (slack < item ? item : 0);
      if (score < bestRem) { bestRem = score; best = i; }
    }
  }
  return best;
}