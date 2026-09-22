function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  const half = item / 2;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let s;
    if (left < half) s = left;
    else s = 1000 + left;
    if (s < bestScore) { bestScore = s; best = i; }
  }
  return best;
}