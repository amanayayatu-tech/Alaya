function chooseBin(item, remainingCapacities) {
  const len = remainingCapacities.length;
  let best = -1;
  let bestRem = 101;
  let bestWaste = 999;
  // Count bins below item size (can't fit) for an opening-pressure signal.
  let totalRem = 0;
  let usable = 0;
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    totalRem += r;
    if (r >= item) usable++;
  }
  // If item is small relative to total slack, prefer best-fit on smallest
  // qualifying bin to consolidate; if item is large, prefer fuller bins.
  const pressure = usable <= 1 ? 1 : 0; // very few bins can take it
  for (let i = 0; i < len; i++) {
    const r = remainingCapacities[i];
    if (r < item) continue;
    const waste = r - item;
    if (waste === 0) return i;
    let w = waste;
    // For large items (low usable count), strongly avoid large leftover gaps.
    if (pressure && waste > item) w += 50;
    // Slight preference to fill bins that are already more than half full
    // when the item fits comfortably, discouraging new opens mid-stream.
    if (r <= 30) w += 0.2;
    else if (r >= 70 && waste <= 5) w -= 0.1;
    if (w < bestWaste || (w === bestWaste && r < bestRem)) {
      bestWaste = w;
      bestRem = r;
      best = i;
    }
  }
  return best;
}