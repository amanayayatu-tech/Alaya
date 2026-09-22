function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
        const s = cap - item;
        if (s < bestSlack) {
          bestSlack = s;
          best = i;
        }
      }
    }
  return best;
}