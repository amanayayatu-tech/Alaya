function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestSlack = 101;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const rem = remainingCapacities[i];
    const s = rem - item;
    if (s >= 0 && s < bestSlack) {
      bestSlack = s;
      best = i;
      if (s === 0) break;
  } }
  return best;
}