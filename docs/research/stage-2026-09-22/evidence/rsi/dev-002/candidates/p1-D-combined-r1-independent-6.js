function chooseBin(item, remainingCapacities){
  const n=remainingCapacities.length;
  let best=-1;
  let bestRem=101;
  let secondRem=101;
  let exactIdx=-1;
  let smallGapIdx=-1;
  let smallGap=101;
  for(let i=0;i<n;i++){
    const r=remainingCapacities[i];
    if(r>=item){
      if(r===item){exactIdx=i;break;}
      if(r<smallGap){smallGap=r;smallGapIdx=i;}
      if(r<bestRem){secondRem=bestRem;bestRem=r;best=i;}
      else if(r<secondRem){secondRem=r;}
    }
  }
  if(exactIdx!==-1)return exactIdx;
  if(smallGapIdx!==-1){
    const r=remainingCapacities[smallGapIdx];
    const gap=r-item;
    if(n<=2||gap<=10)return smallGapIdx;
  }
  if(best!==-1){
    const gap=bestRem-item;
    if(gap>35&&secondRem<=101){
      const newBinEstimate=1;
      if(secondRem+item<=100)return -1;
    }
  }
  return best;
}