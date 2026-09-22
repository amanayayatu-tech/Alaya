function chooseBin(item, remainingCapacities) {
  let n = remainingCapacities.length;
  if (n === 0) return -1;
  let worstSlack = -1, worstIdx = -1;
  for (let i = 0; i < n; i++) {
    let c = remainingCapacities[i];
    if (c >= item && (worstIdx === -1 || c - item > worstSlack)) {
      worstSlack = c - item;
      worstIdx = i;
    }
  }
  if (worstIdx !== -1) return worstIdx;
  let mostFull = -1, mostFullIdx = -1;
  for (let i = 0; i < n; i++) {
    let c = remainingCapacities[i];
    if (c > mostFull) { mostFull = c; mostFullIdx = i; }
  }
  return -1;
}