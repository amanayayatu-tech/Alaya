function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  const len = remainingCapacities.length;
  for (let i = 0; i < len; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const slack = cap - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  if (best !== -1 && bestSlack > 40 && item <= 50) {
    for (let i = 0; i < len; i++) {
      if (i !== best && remainingCapacities[i] >= item) {
        return i;
      }
    }
  }
  return best;
}