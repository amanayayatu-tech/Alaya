function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item && (best === -1 || remainingCapacities[i] < remainingCapacities[best])) best = i;
  }
  if (best === -1) return -1;
  // Threshold: for large items in an already-populated pack, consider Best Fit with leftover slack penalty
  if (item >= 40 && n >= 4) {
    let alt = -1;
    let altScore = Infinity;
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item) {
        const slack = remainingCapacities[i] - item;
        // Penalize slack: prefer tighter fits, but also consider not filling if slack > 30
        const score = slack + (slack > 30 ? slack * 0.5 : 0);
        if (score < altScore) { altScore = score; alt = i; }
      }
    }
    if (alt !== -1 && altScore < (remainingCapacities[best] - item)) best = alt;
  }
  return best;
}