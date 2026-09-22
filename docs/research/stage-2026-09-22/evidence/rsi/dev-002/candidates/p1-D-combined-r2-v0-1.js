function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const left = r - item;
    let score;
    if (left >= item) score = left;
    else if (left >= item / 2) score = 200 + left;
    else score = 400 + left;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}