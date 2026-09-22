function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let bestWaste = 999;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const waste = r - item;
      if (waste === 0) return i;
      let score = waste * 100 + waste;
      if (r <= 25) score += 5;
      else if (r <= 50) score += 2;
      if ((r & 3) === 0) score += 1;
      if (score < bestWaste) { bestWaste = score; bestRem = r; best = i; }
    }
  }
  return best;
}