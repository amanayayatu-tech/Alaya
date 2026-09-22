function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const slack = c - item;
      if (best === -1 || slack < bestSlack) {
        best = i;
        bestSlack = slack;
      }
    }
  }
  return best;
}