function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1;
  let bestSlack = Infinity;
  let firstFit = -1;
  for (let i = 0; i < n; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
      if (firstFit === -1) firstFit = i;
      const slack = rem - item;
      if (slack < bestSlack) { bestSlack = slack; best = i; }
    }
  }
  if (firstFit === -1) return -1;
  // If best-fit leaves substantial room and we could otherwise start fresh,
  // prefer opening a new bin only when the remaining slack is wasted (very tight).
  if (bestSlack > item) return -1;
  return best;
}