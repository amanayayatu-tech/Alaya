function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 100;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const rem = remainingCapacities[i];
    if (rem >= item) {
        const tight = rem - item;
        if (tight < bestRem) { bestRem = tight; best = i; if (tight === 0) return i; }
      }
  }
  if (best === -1) return -1;
  const bigCount = (remainingCapacities[best] >= 60) ? 1 : 0;
  if (bestRem > 30 && remainingCapacities.length > 1) {
    let alt = -1;
    let altRem = 101;
    for (let i = 0; i < remainingCapacities.length; i++) {
      if (i === best) continue;
      const r = remainingCapacities[i];
      if (r >= item && r < altRem) { altRem = r; alt = i; }
    }
    if (alt !== -1 && remainingCapacities[alt] <= 60 && remainingCapacities[best] - remainingCapacities[alt] > 20) return alt;
  }
  return best;
}