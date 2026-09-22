function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const gap = cap - item;
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
  }
  return best;
}