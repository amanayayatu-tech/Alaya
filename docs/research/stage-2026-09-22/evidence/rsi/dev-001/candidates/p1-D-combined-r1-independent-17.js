function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 100;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      // Filler trigger: tight match, but skip near-half if it might form a pair
      if (item <= 35 && r >= item + 5 && r <= item + 20) return i;
      // Prefer very tight fits (minimize leftover waste) for normal items
      if (r - item < bestRem - item) {
        bestRem = r;
        best = i;
      }
    }
  }
  return best;
}