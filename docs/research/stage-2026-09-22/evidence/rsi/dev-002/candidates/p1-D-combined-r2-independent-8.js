function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestCap = 0;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    if (best === -1 || cap < bestCap) {
      best = i;
      bestCap = cap;
    }
  }
  if (best !== -1) return best;
  let open = -1;
  let openCap = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap > openCap) { openCap = cap; open = i; }
  }
  return open;
}