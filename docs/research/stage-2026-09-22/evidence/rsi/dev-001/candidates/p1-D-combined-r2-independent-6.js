function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = 101;
  const n = remainingCapacities.length;
  let tightWorst = 101;
  let tightIdx = -1;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap >= item) {
      const slack = cap - item;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = i;
      }
    } else if (cap < tightWorst) {
      tightWorst = cap;
      tightIdx = i;
    }
  }
  if (best !== -1) return best;
  return -1;
}