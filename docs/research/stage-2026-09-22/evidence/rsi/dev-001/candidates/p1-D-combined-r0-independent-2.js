function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  let secondRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    let r = remainingCapacities[i];
    if (r < item) {
      if (r < secondRem) secondRem = r;
    } else {
      if (r < bestRem) {
        secondRem = bestRem;
        bestRem = r;
        best = i;
      } else if (r < secondRem) {
        secondRem = r;
      }
    }
  }
  if (bestRem > 100 - item && bestRem + secondRem < item * 2) {
    return -1;
  }
  return best;
}