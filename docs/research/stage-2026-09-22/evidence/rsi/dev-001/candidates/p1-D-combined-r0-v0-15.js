function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let best = -1, bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) { best = i; bestRem = r; }
  }
  if (best === -1) return -1;
  const slack = bestRem - item;
  if (slack <= 6) return best;
  if (item >= 50) {
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 23 && r < altRem) { alt = i; altRem = r; }
    }
    if (alt !== -1) return alt;
    if (slack > 31) return -1;
    return best;
  }
  if (item <= 28) {
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 10 && r - item < slack && r < altRem) { alt = i; altRem = r; }
    }
    if (alt !== -1) return alt;
    if (slack <= 12) return best;
    return -1;
  }
  let alt = -1, altRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r - item > 6 && r - item <= 22 && r < altRem) { alt = i; altRem = r; }
  }
  if (alt !== -1 && altRem - item >= 12) return alt;
  return best;
}