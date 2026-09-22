function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestSlack = Infinity;
  let secondSlack = Infinity;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const slack = cap - item;
    if (slack < bestSlack) {
      secondSlack = bestSlack;
      bestSlack = slack;
      best = i;
    } else if (slack < secondSlack) {
      secondSlack = slack;
    }
  }
  // Threshold: if the best fit leaves a residue >= ~item/2 and a near-best exists,
  // consider opening a new bin so a future large item can use the tight bin.
  if (best !== -1 && bestSlack >= Math.floor(item * 0.5) && secondSlack - bestSlack <= Math.floor(item * 0.2)) {
    return -1;
  }
  return best;
}