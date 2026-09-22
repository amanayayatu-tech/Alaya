function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    let cap = remainingCapacities[i];
    if (cap >= item) {
      let slack = cap - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  return best;
}