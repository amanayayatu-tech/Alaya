function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestFit = Infinity;
  let worstOvershoot = Infinity;
  const n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const fit = cap - item;
      if (fit < bestFit) {
        bestFit = fit;
        best = i;
      }
    }
  }
  if (best !== -1) {
    if (bestFit > 5 * item) {
      for (let i = 0; i < n; i++) {
        const cap = remainingCapacities[i];
        const over = item - cap;
        if (over > 0 && over < worstOvershoot) {
          worstOvershoot = over;
          best = i;
        }
      }
    }
    return best;
  }
  if (n > 0) {
    let largest = 0;
    for (let i = 1; i < n; i++) {
      if (remainingCapacities[i] > remainingCapacities[largest]) largest = i;
    }
    if (item - remainingCapacities[largest] <= 0.4 * item) {
      return largest;
    }
  }
  return -1;
}