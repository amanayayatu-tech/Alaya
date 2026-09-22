function chooseBin(item, remainingCapacities) {
  const cap = 100;
  let best = -1;
  let bestResid = cap + 1;
  let fullCount = 0;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r < item) { if (r === 0) fullCount++; continue; }
    const resid = r - item;
    if (resid < bestResid) { bestResid = resid; best = i; }
  }
  if (best !== -1) return best;
  if (fullCount >= remainingCapacities.length * 0.5 && item <= 50) {
    let worst = -1;
    let worstFill = -1;
    for (let i = 0; i < remainingCapacities.length; i++) {
      if (remainingCapacities[i] >= item) continue;
      if (remainingCapacities[i] > worstFill) { worstFill = remainingCapacities[i]; worst = i; }
    }
    if (worst !== -1 && worstFill + item <= cap) {
      const merged = worstFill + item;
      let canMerge = true;
      for (let j = 0; j < remainingCapacities.length; j++) {
        if (j === worst) continue;
        if (remainingCapacities[j] > merged) { canMerge = false; break; }
      }
      if (canMerge) return worst;
    }
  }
  return -1;
}