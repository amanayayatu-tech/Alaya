function chooseBin(item, remainingCapacities) {
  let nBins = remainingCapacities.length;
  if (nBins === 0) return -1;
  let best = -1, second = -1, worstBig = -1, bestSmall = -1, smallestLarge = -1;
  for (let i = 0; i < nBins; i++) {
    let rem = remainingCapacities[i];
    if (rem >= item) {
      if (best === -1 || rem < remainingCapacities[best]) {
        second = best;
        best = i;
      } else if (second === -1 || rem < remainingCapacities[second]) {
        second = i;
      }
    } else {
      if (worstBig === -1 || rem < remainingCapacities[worstBig]) worstBig = i;
    }
    if (bestSmall === -1 || rem < remainingCapacities[bestSmall]) bestSmall = i;
    if (rem >= item && (smallestLarge === -1 || rem - item < remainingCapacities[smallestLarge] - (remainingCapacities[smallestLarge] >= item ? item : 0))) {
      smallestLarge = i;
    }
  }
  let totalRem = 0;
  for (let i = 0; i < nBins; i++) totalRem += remainingCapacities[i];
  if (totalRem + 100 < item) return -1;
  if (best === -1) return -1;
  if (worstBig !== -1 && remainingCapacities[worstBig] + item <= 100) {
    let itemFrac = item / 100;
    let worstRemFrac = remainingCapacities[worstBig] / 100;
    let nSmallFrac = 0;
    for (let i = 0; i < nBins; i++) {
      if (remainingCapacities[i] < item) nSmallFrac += remainingCapacities[i] / 100;
    }
    if (worstRemFrac > itemFrac && nSmallFrac > 1.0) return -1;
  }
  if (second !== -1 && remainingCapacities[best] === remainingCapacities[second]) return -1;
  return best;
}