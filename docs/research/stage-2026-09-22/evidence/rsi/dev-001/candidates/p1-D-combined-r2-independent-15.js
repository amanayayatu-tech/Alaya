function chooseBin(item, remainingCapacities) {
  const CAP = 100;
  const n = remainingCapacities.length;
  const itemNorm = item / CAP;
  // Threshold-based Best-Fit with breakpoint around mean item size (~0.466).
  // For small items, minimize wasted space (tight fit).
  // For large items, prefer bins that fit with some slack to avoid forcing a new bin soon.
  const TH = 0.466;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < n; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const remNorm = cap / CAP;
    const wasteNorm = remNorm - itemNorm; // post-placement waste fraction
    let score;
    if (itemNorm <= TH) {
      // Tight fit: minimize waste, break ties by larger remaining capacity.
      score = wasteNorm;
      if (score === bestScore) {
        score = score - remNorm * 1e-6;
      }
    } else {
      // Large item: avoid leaving tiny unusable residue.
      // Penalize high waste; reward keeping meaningful residual room.
      score = wasteNorm + Math.max(0, 0.2 - remNorm) * 0.5;
      if (score === bestScore) {
        score = score - remNorm * 1e-6;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}