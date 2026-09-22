function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
      const slack = rem - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  if (best !== -1) {
    const rem = remainingCapacities[best];
    if (rem - item >= 0.6 * item && rem > item * 2 && bestSlack < 0.3 * item) {
      return -1;
    }
    return best;
  }
  if (item <= 30) {
    for (let i = 0; i < n; i++) {
      if (remainingCapacities[i] >= item * 2) return -1;
    }
  }
  return -1;
}