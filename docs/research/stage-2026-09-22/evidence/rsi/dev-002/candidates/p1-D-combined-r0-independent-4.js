function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestRem = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const r = remainingCapacities[i];
    if (r >= item) {
      if (r < bestRem) {
        bestRem = r;
        best = i;
      } else if (r === bestRem && best !== -1) {
        const cr = remainingCapacities[best];
        if (cr + item > 100 && r + item <= 100) best = i;
        else if (cr + item > 100 && r + item > 100) {
          if (r - item < cr - item) best = i;
        }
      }
    }
  }
  return best;
}