function chooseBin(item, remainingCapacities) {
  let best = -1;
  let n = remainingCapacities.length;
  // Tight-fit threshold: only consider bins whose residual is < 2*item
  // (or the smallest residual if it already fits). Falls back to smallest.
  let tightLimit = 2 * item;
  let smallLimit = item;
  for (let i = 0; i < n; i++) {
    let r = remainingCapacities[i];
    if (r < smallLimit) continue;
    if (best === -1) { best = i; continue; }
    let br = remainingCapacities[best];
    // Prefer tighter fits, but avoid leaving very tight gaps (< item)
    // that would likely require a new bin for a future medium item.
    if (br < smallLimit) { best = i; continue; }
    if (r < br) {
      if (r < tightLimit || br >= tightLimit) best = i;
    } else {
      if (br < tightLimit && r >= tightLimit) {/* keep best (tighter) */} else if (r < br) best = i;
    }
  }
  if (best !== -1) return best;
  // Fallback: exact smallest remaining capacity that fits.
  best = -1;
  for (let i = 0; i < n; i++) {
    if (remainingCapacities[i] >= item && (best === -1 || remainingCapacities[i] < remainingCapacities[best])) best = i;
  }
  return best;
}