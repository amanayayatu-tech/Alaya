function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestWaste = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const waste = cap - item;
      if (waste < bestWaste) { bestWaste = waste; best = i; }
    }
  }
  return best;
}