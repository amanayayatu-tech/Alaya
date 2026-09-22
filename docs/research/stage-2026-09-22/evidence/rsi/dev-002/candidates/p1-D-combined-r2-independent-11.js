function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const slack = c - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  return best;
}