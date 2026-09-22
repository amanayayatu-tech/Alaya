function chooseBin(item, remainingCapacities) {
  const n = remainingCapacities.length;
  if (n === 0) return -1;
  let tight = -1, tightRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r < tightRem) { tight = i; tightRem = r; }
  }
  if (tight === -1) return -1;
  const slack = tightRem - item;
  if (slack <= 6) return tight;
  if (item >= 51) {
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 20 && r < altRem) { alt = i; altRem = r; }
    }
    if (alt !== -1) return alt;
    if (slack > 34) return -1;
    return tight;
  }
  if (item <= 28) {
    let alt = -1, altRem = 101;
    for (let i = 0; i < n; i++) {
      const r = remainingCapacities[i];
      if (r >= item && r - item <= 12 && r - item < tightRem - item && r < altRem) { alt = i; altRem = r; }
    }
    if (alt !== -1) return alt;
    if (slack <= 14) return tight;
    return -1;
  }
  let alt = -1, altRem = 101;
  for (let i = 0; i < n; i++) {
    const r = remainingCapacities[i];
    if (r >= item && r - item > 6 && r - item <= 24 && r < altRem) { alt = i; altRem = r; }
  }
  if (alt !== -1 && altRem - item >= 14) return alt;
  return tight;
}