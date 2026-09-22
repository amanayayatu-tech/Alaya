function chooseBin(item, remainingCapacities) {
  let best = -1;
  let n = remainingCapacities.length;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item) {
      if (best === -1 || remainingCapacities[i] < remainingCapacities[best]) best = i;
    }
  }
  if (best !== -1) return best;
  let openIdx = -1;
  let openVal = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] > openVal) { openVal = remainingCapacities[i]; openIdx = i; }
  }
  if (item <= 50) return openIdx;
  let small = -1;
  let smallVal = 101;
  let medium = -1;
  let mediumVal = 101;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) continue;
    if (r <= 35 && r < smallVal) { smallVal = r; small = i; }
    else if (r <= 65 && r < mediumVal) { mediumVal = r; medium = i; }
  }
  if (small !== -1) return small;
  if (medium !== -1) return medium;
  return openIdx;
}