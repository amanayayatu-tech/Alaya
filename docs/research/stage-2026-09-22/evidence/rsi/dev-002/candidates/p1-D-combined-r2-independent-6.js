function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (n === 0) return -1;
  let small = [], large = [];
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      if (remainingCapacities[i] <= 2 * item) small.push(i);
      else large.push(i);
    }
  }
  if (small.length > 0) {
    let best = small[0];
    for (let i = 1; i < small.length; i++) {
      if (remainingCapacities[small[i]] < remainingCapacities[best]) best = small[i];
    }
    return best;
  }
  if (large.length > 0) {
    let best = large[0];
    for (let i = 1; i < large.length; i++) {
      if (remainingCapacities[large[i]] < remainingCapacities[best]) best = i;
    }
    return best;
  }
  return -1;
}