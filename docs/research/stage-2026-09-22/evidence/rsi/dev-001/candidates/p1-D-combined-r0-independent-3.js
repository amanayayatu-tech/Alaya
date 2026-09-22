function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    let cap = remainingCapacities[i];
    if (cap < item) continue;
    let slack = cap - item;
    if (best === -1 || slack < bestSlack) { best = i; bestSlack = slack; }
  }
  return best;
}