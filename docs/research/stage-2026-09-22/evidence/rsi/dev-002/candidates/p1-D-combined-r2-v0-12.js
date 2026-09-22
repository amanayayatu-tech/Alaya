function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  const c = 100;
  const item2 = item * 2;
  const item3 = item * 3;
  const item4 = item * 4;
  const item5 = item * 5;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let s;
    if (left < item2) s = left;
    else if (left < item3) s = 1000 + left;
    else if (left < item4) s = 2000 + left;
    else if (left < item5) s = 3000 + left;
    else if (left >= c - item) s = 8000 + left;
    else s = 4000 + left;
    if (s < bestScore) { bestScore = s; best = i; }
  }
  return best;
}