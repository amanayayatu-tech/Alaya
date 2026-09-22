function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  let secondSlack = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item) {
      let slack = remainingCapacities[i] - item;
      if (slack < bestSlack) {
        secondSlack = bestSlack;
        bestSlack = slack;
        best = i;
      } else if (slack < secondSlack) {
        secondSlack = slack;
      }
    }
  }
  if (best === -1) return -1;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item) { sum += remainingCapacities[i] - item; cnt++; }
  }
  if (cnt >= 3 && secondSlack <= sum / cnt) return best;
  if (cnt >= 3 && bestSlack > sum / cnt * 1.5) return -1;
  return best;
}