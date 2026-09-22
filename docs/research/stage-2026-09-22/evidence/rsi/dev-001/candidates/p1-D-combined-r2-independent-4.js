function chooseBin(item, remainingCapacities) {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < remainingCapacities.length; i++) {
    const cap = remainingCapacities[i];
    if (cap < item) continue;
    const residual = cap - item;
    let score;
    if (residual < item * 0.5) score = 0;
    else if (residual < item) score = 1;
    else if (residual < item * 1.5) score = 2;
    else score = 3;
    if (best === -1 || score < bestScore || (score === bestScore && cap < remainingCapacities[best])) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}