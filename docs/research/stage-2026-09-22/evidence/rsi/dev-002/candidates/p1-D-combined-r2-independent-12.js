function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (item > 100) return -1;
  let tight = -1, tightRem = 101;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item && r - item < tightRem) {
      tight = i;
      tightRem = r - item;
    }
  }
  return tight;
}