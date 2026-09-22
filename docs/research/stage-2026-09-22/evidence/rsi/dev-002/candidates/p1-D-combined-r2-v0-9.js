function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  const item1 = item;
  const item2 = item * 2;
  const item3 = item * 3;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let s;
    if (left < item1) s = left;
    else if (left < item2) s = 1000 + left;
    else if (left < item3) s = 2000 + left;
    else s = 4000 + left;
    if (s < bestScore) { bestScore = s; best = i; }
  }
  return best;
}