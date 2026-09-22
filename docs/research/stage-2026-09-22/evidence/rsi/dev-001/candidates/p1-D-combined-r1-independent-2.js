function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = -1;
  const len = remainingCapacities.length;
  for (let i = 0; i < len; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item && cap > bestCap) {
      bestCap = cap;
      best = i;
    }
  }
  return best;
}