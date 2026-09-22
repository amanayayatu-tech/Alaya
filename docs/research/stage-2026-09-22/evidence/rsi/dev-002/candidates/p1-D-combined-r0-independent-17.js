function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRem = -1;
  for (let i = 0; i < n; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
      if (best === -1) {
        best = i;
        bestRem = rem;
      } else {
        const diff = rem - item;
        const bestDiff = bestRem - item;
        if (diff < bestDiff || (diff === bestDiff && rem > bestRem)) {
          best = i;
          bestRem = rem;
        }
      }
    }
  }
  if (best !== -1) return best;
  let openIdx = -1;
  let openRem = -1;
  for (let i = 0; i < n; i++) {
    const rem = remainingCapacities[i];
    if (best === -1 || rem > openRem) {
      openIdx = i;
      openRem = rem;
    }
  }
  return openIdx;
}
