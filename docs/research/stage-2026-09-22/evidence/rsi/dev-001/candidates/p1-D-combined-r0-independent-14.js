function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = -1;
  let newBinIfFail = 100 - item;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item) {
      let slack = remainingCapacities[i] - item;
      if (slack > bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
  }
  if (best !== -1 && bestSlack <= newBinIfFail) return best;
  return -1;
}