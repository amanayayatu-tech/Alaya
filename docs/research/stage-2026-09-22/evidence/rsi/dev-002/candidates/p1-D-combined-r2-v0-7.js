function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let s;
    if (left < item) s = left;
    else if (left < item * 2) s = 1000 + left;
    else s = 2000 + left;
    if (s < bestScore) { bestScore = s; best = i; }
  }
  return best;
}