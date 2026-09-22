function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (n === 0) return -1;
  if (item > 100) return -1;
  let minFree = -1;
  let minIdx = -1;
  let secondMin = -1;
  for (let i = 0; i < n; i++) {
    let f = remainingCapacities[i];
    if (f >= item) {
      if (minIdx === -1 || f < minFree) {
        secondMin = minFree;
        minFree = f;
        minIdx = i;
      } else if (secondMin === -1 || f < secondMin) {
        secondMin = f;
      }
    }
  }
  if (minIdx === -1) return -1;
  if (minFree > 60) return -1;
  if (minFree <= 20) return minIdx;
  let wasteIfPack = minFree - item;
  if (secondMin !== -1) {
    let secondWasteIfPack = secondMin - item;
    if (secondWasteIfPack < wasteIfPack - 5) return -1;
  }
  if (minFree >= 40 && minFree - item > 15) return -1;
  return minIdx;
}