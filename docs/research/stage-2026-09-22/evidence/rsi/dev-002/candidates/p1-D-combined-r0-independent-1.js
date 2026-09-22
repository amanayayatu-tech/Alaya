function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const slack = cap - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  return best;
}