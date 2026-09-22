function chooseBin(item, remainingCapacities){
 const n=remainingCapacities.length;
 let tight=-1,tightGap=Infinity;
 let worstEmpty=-1,worstCap=-1;
 let totalFree=0;
 for(let i=0;i<n;i++){
 const c=remainingCapacities[i];
 totalFree+=c;
 if(c>=item){const g=c-item;if(g<tightGap){tightGap=g;tight=i;}}
 else{if(c>worstCap){worstCap=c;worstEmpty=i;}}
 }
 if(tight!==-1)return tight;
 if(worstEmpty!==-1){
 const worstFit=item-worstCap;
 const avgPerBin=totalFree/Math.max(1,n);
 const projectedNewBins=avgPerBin>0?item/avgPerBin:1;
 const threshold=0.45*item*(projectedNewBins>0.7?1.2:1);
 if(worstFit<=threshold)return worstEmpty;
 }
 return -1;
}