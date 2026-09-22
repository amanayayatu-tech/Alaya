function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item) {
      const slack = remainingCapacities[i] - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  return best;
}