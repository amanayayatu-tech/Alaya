function chooseBin(item, remainingCapacities){
  let best=-1;
  let bestCap=101;
  const n=remainingCapacities.length;
  for(let i=0;i<n;i++){
    const c=remainingCapacities[i];
    if(c===item){
      return i;
    }
    if(c>item){
      if(c<bestCap){
        bestCap=c;
        best=i;
      }
    }
  }
  return best;
}