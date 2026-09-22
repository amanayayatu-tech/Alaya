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
  return best;
}