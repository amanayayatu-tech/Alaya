import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {hash,baseline,average,BEST_FIT} from '../../../experiments/rsi-binpack/domain.ts';
import {score} from '../../../experiments/rsi-binpack/sandbox.ts';
import {verify} from '../../../experiments/rsi-binpack/runner.ts';
import {analyze} from '../../../experiments/rsi-binpack/analyze.ts';
import {costEstimate} from '../../../experiments/rsi-binpack/llm.ts';

const dir=dirname(fileURLToPath(import.meta.url));
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=p=>fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
verify(dir);
const records=lines(join(dir,'results.jsonl'));
const trials=records.filter(x=>x.event==='trial_complete');
const attempts=records.filter(x=>x.event==='candidate');
const receipts=lines(join(dir,'requests.jsonl'));
const sent=receipts.filter(x=>x.event==='request');
assert.equal(sent.length,120);assert.equal(trials.length,6);assert.equal(attempts.length,120);
assert.equal(new Set(sent.map(x=>x.id)).size,120);
const checks=[];
for(const trial of trials){
  const candidates=attempts.filter(x=>x.trial===trial.trial);
  assert.equal(candidates.length,20);
  assert.equal(sent.filter(x=>x.trial===trial.trial).length,20);
  const data=split=>['D1','D2','D3'].flatMap(w=>json(join(dir,'private-dataset',`${w}-${trial.repeat}-${split}.json`)));
  const dev=data('dev'),train=data('train'),test=data('test');
  const base={id:'best-fit',attempt:-1,code:BEST_FIT,dev:{valid:true,mean:average(dev.map(x=>baseline(x.items)))}};
  const selected=[base,...candidates].filter(x=>x.dev.valid).sort((a,b)=>a.dev.mean-b.dev.mean||a.code.length-b.code.length||a.attempt-b.attempt)[0];
  const frozen=json(join(dir,'candidates',`${trial.trial}-frozen.json`));
  assert.equal(selected.id,trial.selected);assert.equal(hash(selected.code),frozen.codeHash);
  for(const c of candidates){assert.equal(hash(c.code),c.codeHash);const saved=json(join(dir,'candidates',`${c.id}.json`));assert.equal(hash(saved.code),c.codeHash);}
  const trainHashes=new Set(train.map(x=>hash(x.items)));
  for(const r of sent.filter(x=>x.trial===trial.trial)){
    const body=r.body,payload=JSON.parse(body.messages[1].content),context=payload.context;
    assert.deepEqual(payload.draft_output,{});
    assert.equal(body.model,'MiniMax-M3');assert.equal(body.temperature,0.7);assert.equal(body.max_tokens,3000);assert.equal(body.thinking.type,'disabled');
    assert.ok(Buffer.byteLength(JSON.stringify(body))<=8000);
    assert.ok(Object.keys(context).every(k=>['worlds','train','currentCode','instruction','currentTrainMean','history','examples'].includes(k)));
    if(trial.arm==='independent')assert.equal(context.history,undefined);else assert.ok(Array.isArray(context.history));
    for(const example of context.examples??[])if(example.items)assert.ok(trainHashes.has(hash(example.items)));
    for(const h of context.history??[])assert.ok(!('dev' in h)&&!('test' in h));
    assert.equal(receipts.filter(x=>x.id===r.id&&['response','transport_error'].includes(x.event)).length,1);
  }
  checks.push({trial:trial.trial,code:selected.code,test,recorded:trial.test});
}
const replay=[];
for(let i=0;i<checks.length;i+=3){
  await Promise.all(checks.slice(i,i+3).map(async c=>{
    const result=await score(c.code,c.test);
    assert.equal(result.valid,c.recorded.valid);assert.equal(result.mean,c.recorded.mean);assert.deepEqual(result.bins,c.recorded.bins);
    replay.push({trial:c.trial,valid:result.valid,mean:result.mean,instances:result.bins.length,binsHash:hash(result.bins)});
  }));
}
const before=hash(json(join(dir,'summary.json')));
const summary=analyze(dir);
assert.equal(hash(summary),before);
const costDirs=['preflight-20260922','dev-001/preflight','dev-001','dev-002/preflight','dev-002'];
const costRows=costDirs.map(name=>{
  const rows=lines(join(dir,'..',name,'requests.jsonl')),requests=rows.filter(x=>x.event==='request'),responses=rows.filter(x=>x.event==='response');
  return {name,requests:requests.length,responses:responses.length,knownPaygEquivalentUsd:responses.reduce((s,x)=>s+(costEstimate(x.usage).costUsd??0),0),unknownUsageRequests:requests.length-responses.filter(x=>x.usage).length};
});
const details=['independent','v0'].map(arm=>{
  const rows=attempts.filter(x=>x.arm===arm),r=receipts.filter(x=>x.trial?.endsWith('-'+arm));
  return {arm,attempts:rows.length,legalCandidates:rows.filter(x=>x.train.valid&&x.dev.valid).length,transportErrors:r.filter(x=>x.event==='transport_error').length,
    algorithmInvalid:rows.filter(x=>x.train.error?.startsWith('Error:')).length,
    trainingBetterThanBestFit:rows.filter(x=>x.train.valid&&x.train.mean<average(['D1','D2','D3'].flatMap(w=>json(join(dir,'private-dataset',`${w}-${x.repeat}-train.json`))).map(z=>baseline(z.items)))).length,
    schemaValidResponses:rows.filter(x=>json(join(dir,'candidates',`${x.id}.response.json`)).schemaValid).length,
    inputTokens:r.filter(x=>x.event==='response').reduce((s,x)=>s+(x.usage?.prompt_tokens??0),0),outputTokens:r.filter(x=>x.event==='response').reduce((s,x)=>s+(x.usage?.completion_tokens??0),0)};
});
const receipt={evidence:'DEVELOPMENT',checkedAt:new Date().toISOString(),checks:'source/data hashes; HTTP count/allocation and no mock fixture; training-only prompt content; dev-only selection; six container replays; identical summary recomputation',replay,details,costRows,
  totalRequests:costRows.reduce((s,x)=>s+x.requests,0),knownPaygEquivalentUsd:costRows.reduce((s,x)=>s+x.knownPaygEquivalentUsd,0),unknownUsageRequests:costRows.reduce((s,x)=>s+x.unknownUsageRequests,0),
  conservativeAllocationForUnknownUsd:costRows.reduce((s,x)=>s+x.unknownUsageRequests,0)*0.006,summaryHash:hash(summary)};
fs.writeFileSync(join(dir,'readback.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
