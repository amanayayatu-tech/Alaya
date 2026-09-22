function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const slack = c - item;
      if (slack < bestSlack) { bestSlack = slack; best = i; }
    }
  }
  return best;
}