function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  const len = remainingCapacities.length;
  for (let i = 0; i < len; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const slack = c - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  if (best !== -1 && bestSlack <= 11) return best;
  return -1;
}