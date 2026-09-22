function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    let cap = remainingCapacities[i];
    if (cap >= item && cap < bestCap) { bestCap = cap; best = i; }
  }
  return best;
}