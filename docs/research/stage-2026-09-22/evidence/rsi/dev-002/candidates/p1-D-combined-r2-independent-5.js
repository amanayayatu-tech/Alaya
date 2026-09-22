function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) { bestRem = r; best = i; }
    }
  }
  if (best === -1) return -1;
  let rem = bestRem - item;
  if (rem > 50) {
    let second = -1;
    let secondRem = -1;
    for (let j = 0; j < n; j++) {
      if (j === best) continue;
      let r2 = remainingCapacities[j];
      if (r2 >= item) {
        if (r2 > secondRem) { secondRem = r2; second = j; }
      }
    }
    if (second !== -1) {
      let rem2 = secondRem - item;
      let waste1 = rem + 101;
      let waste2 = rem2 + 101;
      if (item >= 40 && rem2 <= rem + 25) {
        return second;
      }
      if (rem2 <= 12 && rem > 50) {
        return second;
      }
    }
  }
  return best;
}