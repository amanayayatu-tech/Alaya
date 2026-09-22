function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) { best = i; bestRem = r; }
  }
  if (best === -1) return -1;
  const slack = bestRem - item;
  if (item <= 24) {
    let tight = -1, tightRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 14 && r - item < tightRem - item) {
        tight = i; tightRem = r;
      }
    }
    if (tight !== -1) return tight;
  } else if (item <= 50) {
    if (slack <= 8) return best;
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item > 8 && r - item <= 22 && r < altRem) {
        alt = i; altRem = r;
      }
    }
    if (alt !== -1 && altRem - item >= 16) return alt;
    return best;
  } else {
    if (slack <= 10) return best;
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 18 && r < altRem) {
        alt = i; altRem = r;
      }
    }
    if (alt !== -1) return alt;
    if (slack > 35) return -1;
  }
  return best;
}