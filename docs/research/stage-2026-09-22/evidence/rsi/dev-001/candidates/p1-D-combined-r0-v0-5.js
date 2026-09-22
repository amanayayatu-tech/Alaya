function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < bestRem) {
      best = i;
      bestRem = r;
    }
  }
  if (best === -1) return -1;
  if (bestRem - item <= 5) return best;
  if (item >= 50) {
    let alt = -1;
    let altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item < bestRem - item && r - item <= 15) {
        if (r < altRem) { alt = i; altRem = r; }
      }
    }
    if (alt !== -1) return alt;
    if (bestRem - item > 30) return -1;
  } else if (item <= 30) {
    let alt = -1;
    let altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item < bestRem - item && r - item <= 10) {
        if (r < altRem) { alt = i; altRem = r; }
      }
    }
    if (alt !== -1) return alt;
  } else {
    let alt = -1;
    let altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r < bestRem) {
        best = i; bestRem = r;
      }
    }
  }
  return best;
}