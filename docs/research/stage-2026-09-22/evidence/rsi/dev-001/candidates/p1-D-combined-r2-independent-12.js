function chooseBin(item, remainingCapacities) {
  let best = -1;
  let n = remainingCapacities.length;
  let threshold = item + 5;
  if (threshold > 100) threshold = 100;
  for (let i = 0; i < n; i++) {
    let cap = remainingCapacities[i];
    if (cap >= item) {
      if (best === -1 || cap < remainingCapacities[best]) best = i;
    }
  }
  if (best !== -1) {
    let capBest = remainingCapacities[best];
    let waste = capBest - item;
    if (waste <= 5) return best;
  }
  let smallBest = -1;
  let tooLarge = -1;
  for (let i = 0; i < n; i++) {
    let cap = remainingCapacities[i];
    if (cap >= threshold && (tooLarge === -1 || cap < remainingCapacities[tooLarge])) {
      tooLarge = i;
    }
    if (cap >= item && cap < threshold && (smallBest === -1 || cap < remainingCapacities[smallBest])) {
      smallBest = i;
    }
  }
  if (smallBest !== -1) return smallBest;
  if (tooLarge !== -1 && remainingCapacities[tooLarge] - item <= 30) return tooLarge;
  return best;
}