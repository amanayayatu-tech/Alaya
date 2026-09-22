function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  const half = item / 2;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let s;
    if (left >= item) s = left;
    else if (left >= half) s = 200 + left;
    else if (left >= half / 2) s = 400 + left;
    else s = 600 + left;
    if (s < bestScore) { bestScore = s; best = i; }
  }
  if (best !== -1) return best;
  return -1;
}