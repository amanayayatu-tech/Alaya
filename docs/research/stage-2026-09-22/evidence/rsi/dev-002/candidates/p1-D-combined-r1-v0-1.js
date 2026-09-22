function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let bestW = 0;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      const w = r - item;
      if (w === 0) return i;
      const tight = r * 100 + w;
      if (tight < bestW || best === -1) { bestW = tight; bestRem = r; best = i; }
    }
  }
  return best;
}