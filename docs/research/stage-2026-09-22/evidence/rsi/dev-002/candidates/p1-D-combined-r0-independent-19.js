function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  let bestIdx = -1;
  let bestSlack = Infinity;
  let openIdx = -1;
  let openBestSlack = Infinity;
  for (let i = 0; i < n; i++) {
    let c = remainingCapacities[i];
    if (c >= item) {
      let slack = c - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        bestIdx = i;
      }
    } else {
      let slack = item - c;
      if (slack < openBestSlack) {
        openBestSlack = slack;
        openIdx = i;
      }
    }
  }
  if (bestIdx !== -1) return bestIdx;
  return -1;
}