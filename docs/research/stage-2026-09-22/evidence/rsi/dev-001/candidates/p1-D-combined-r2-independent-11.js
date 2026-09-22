function chooseBin(item, remainingCapacities) {
  let best = -1;
  let worst = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const c = remainingCapacities[i];
    if (c >= item) {
      if (best === -1 || c < remainingCapacities[best]) best = i;
    } else {
      if (worst === -1 || c > remainingCapacities[worst]) worst = i;
    }
  }
  if (best !== -1) return best;
  return worst !== -1 ? worst : -1;
}