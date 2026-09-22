function chooseBin(item, remainingCapacities) {
  let best = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    if (remainingCapacities[i] >= item && (best === -1 || remainingCapacities[i] < remainingCapacities[best])) best = i;
  }
  if (best !== -1) {
    let n = remainingCapacities[best];
    let waste = n - item;
    if (waste > 60) {
      let alt = -1;
      for (let i = 0; i < remainingCapacities.length; i++) {
        if (i !== best && remainingCapacities[i] >= item && (alt === -1 || remainingCapacities[i] < remainingCapacities[alt])) alt = i;
      }
      if (alt !== -1 && (remainingCapacities[alt] - item) <= waste) best = alt;
    }
  }
  return best;
}