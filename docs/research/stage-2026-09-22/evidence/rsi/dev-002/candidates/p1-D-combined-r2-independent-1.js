function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  let secondBestSlack = Infinity;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      const slack = c - item;
      if (slack < bestSlack) {
        secondBestSlack = bestSlack;
        bestSlack = slack;
        best = i;
      } else if (slack < secondBestSlack) {
        secondBestSlack = slack;
      }
    }
  }
  if (best !== -1 && bestSlack <= 30 && secondBestSlack - bestSlack <= 15) {
    let newBinNeeded = true;
    for (let i = 0; i < n; i++) {
      if (i !== best && remainingCapacities[i] >= item && remainingCapacities[i] - item <= bestSlack + 25) {
        newBinNeeded = false;
        break;
      }
    }
    if (newBinNeeded) return best;
  }
  if (best !== -1 && bestSlack > 60) return best;
  if (best !== -1 && bestSlack <= 20) return -1;
  return best;
}