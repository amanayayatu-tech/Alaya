function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    const diff = cap - item;
    if (diff >= 0 && diff < bestSlack) { bestSlack = diff; best = i; }
  }
  return best;
}