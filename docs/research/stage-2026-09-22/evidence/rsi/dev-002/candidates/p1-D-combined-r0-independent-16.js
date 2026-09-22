function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = Infinity;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const slack = cap - item;
    if (slack < bestSlack || (slack === bestSlack && (best === -1 || cap > remainingCapacities[best]))) {
      bestSlack = slack;
      best = i;
    }
  }
  if (best === -1) return -1;
  // Avoid wasting tight fits on mid-size items: if there's an exact fit, prefer it
  if (bestSlack === 0) return best;
  // If slack is large (>40% of bin), consider opening new bin if item is large (>50% of bin)
  if (bestSlack > 40 && item > 50) {
    // Only open new bin if it would leave substantial room elsewhere
    let largeBin = -1;
    let largeSlack = 0;
    for (let j = 0; j < remainingCapacities.length; j++) {
      if (remainingCapacities[j] >= item) continue;
      const s = 100 - remainingCapacities[j];
      if (s > largeSlack) { largeSlack = s; largeBin = j; }
    }
    // Don't open new if a very full bin exists
    if (largeBin !== -1 && largeSlack >= 50) return -1;
  }
  return best;
}