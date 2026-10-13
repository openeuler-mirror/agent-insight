import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root=process.argv[2], sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const protocolBytes=fs.readFileSync(path.join(root,'protocol.json')),protocol=JSON.parse(protocolBytes.toString());
const manifestBytes=fs.readFileSync(path.join(root,'pool-manifest.json')),manifest=JSON.parse(manifestBytes.toString());
for(const [f,h] of Object.entries(protocol.codeHashes))assert.equal(sha(fs.readFileSync(f)),h);
const reports=Object.keys(manifest.sources).map(name=>({name,bytes:fs.readFileSync(path.join(root,`${name}-selections.json`))}));
for(const {bytes} of reports)assert.ok(JSON.parse(bytes.toString()).finishedAt,'all selection IDs must be frozen before reading labels');
const mean=(a:number[])=>a.reduce((x,y)=>x+y,0)/a.length;
const bucket=(n:number)=>n<=32?0:n<=128?1:n<=512?2:3;
const task=(input:string)=>{const rules=[/\b(code|debug|implement|refactor|function|program|script|sql)\b|代码|编程|函数|修复.*bug/i,/\b(analy[sz]e|extract|classify|convert|calculate|csv|json)\b|分析|提取|分类|计算|转换/i,/\b(send|schedule|deploy|install|delete|create.*ticket)\b|发送|部署|安装|删除|创建.*工单/i,/\b(write|draft|compose|translate|summari[sz]e)\b|写作|撰写|翻译|总结|摘要/i,/\b(what|who|when|where|why|how|find|search|explain)\b|查询|搜索|什么|如何|解释|为什么/i];const i=rules.findIndex(r=>r.test(input));return i<0?5:i;};
const all:any[]=[];let count=0,selectedItems=0,signatureChecks=0;
for(const {name,bytes} of reports){
 const r=JSON.parse(bytes.toString());assert.equal(r.protocolSha256,sha(protocolBytes));assert.equal(r.poolManifestSha256,sha(manifestBytes));assert.equal(r.labelsRead,false);
 for(const [f,h]of Object.entries(r.codeHashes))assert.equal(sha(fs.readFileSync(f)),h);
 const textBytes=fs.readFileSync(path.join(root,`${name}-text.json`)),labelBytes=fs.readFileSync(path.join(root,`${name}-labels.json`));
 assert.equal(sha(textBytes),r.textSha256);assert.equal(sha(labelBytes),manifest.sources[name].labelsSha256);
 const text:any[]=JSON.parse(textBytes.toString()),labels=JSON.parse(labelBytes.toString());
 const byKey=new Map(text.map(row=>[row.key,{...row,tokens:row.input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu)||[],inputKey:sha(JSON.stringify([row.input]))}]));
 const groupPanels=new Map<string,string>();
 for(const s of r.scenarios){
  count++;const pool=s.poolKeys.map((key:string)=>byKey.get(key)!);assert.ok(pool.every(Boolean));assert.equal(pool.length,s.n);
  if(s.pool!=='full')for(const row of pool){const before=groupPanels.get(row.component);assert.ok(!before||before===s.pool);groupPanels.set(row.component,s.pool);}
  const metrics:any={};
  for(const method of protocol.methods){
   const m=s.methods[method],keys:string[]=m.selected;assert.equal(keys.length,Math.min(s.k,s.n));assert.equal(new Set(keys).size,keys.length);assert.ok(keys.every(k=>s.poolKeys.includes(k)));selectedItems+=keys.length;
   const selected=keys.map(k=>byKey.get(k)!),vocab=new Set<string>(),axes:Record<string,number[]>={};let tokens=0;
   for(const row of selected){tokens+=row.tokens.length;for(const t of row.tokens)vocab.add(t);for(const [axis,value]of Object.entries<number>(labels[row.key]||{})){assert.ok(Number.isFinite(value));(axes[axis]||=[]).push(value);}}
   metrics[method]={count:keys.length,inputs:new Set(selected.map(row=>row.inputKey)).size,vocabulary:vocab.size,tokens,quality:Object.fromEntries(Object.entries(axes).map(([a,v])=>[a,{mean:mean(v),labeled:v.length}])),selectionMs:m.selectionMs};
   if(method==='V632'||method==='V635'){
    const unique=(a:any[])=>[...new Map(a.map(row=>[row.inputKey,row])).values()],ps=unique(pool),qs=unique(selected),o=m.optimization;
    const cap=Math.floor(1.1*keys.length*mean(ps.map(row=>row.tokens.length))+1e-9);
    const tv=(classifier:(r:any)=>number,n:number)=>{const a=Array(n).fill(0),b=Array(n).fill(0);for(const row of ps)a[classifier(row)]++;for(const row of qs)b[classifier(row)]++;return a.reduce((sum,x,i)=>sum+Math.abs(x/ps.length-b[i]/qs.length),0)/2;};
    assert.equal(o.tokenBudget,cap);assert.equal(o.tokens,tokens);assert.equal(o.vocabulary,vocab.size);
    const lt=tv(row=>bucket(row.tokens.length),4),tt=tv(row=>task(row.input),6);
    assert.ok(Math.abs(lt-o.lengthTV)<1e-10);assert.ok(Math.abs(tt-o.taskTV)<1e-10);
    if(o.feasible){assert.ok(tokens<=cap);assert.ok(lt<=Math.max(.1,2/qs.length)+1e-9);assert.ok(tt<=Math.max(.2,2/qs.length)+1e-9);}else assert.deepEqual(keys,s.methods.V4.selected);
    metrics[method].feasible=o.feasible;metrics[method].budget=cap;
   }
  }
  const cap=Math.min(...Object.values<any>(metrics).map(m=>m.tokens));
  for(const method of protocol.methods){
   const ordered=[...s.methods[method].selected].sort((a:string,b:string)=>sha(JSON.stringify(['budget-order',s.seed,a])).localeCompare(sha(JSON.stringify(['budget-order',s.seed,b])))||a.localeCompare(b));
   let remaining=cap;const vocab=new Set<string>();
   for(const key of ordered){for(const t of byKey.get(key)!.tokens.slice(0,remaining))vocab.add(t);remaining-=Math.min(remaining,byKey.get(key)!.tokens.length);if(!remaining)break;}
   metrics[method].matchedVocabulary=vocab.size;metrics[method].matchedBudget=cap;
  }
  all.push({source:name,pool:s.pool,n:s.n,groups:s.groupCount,k:s.k,seed:s.seed,methods:metrics});
 }
 signatureChecks+=r.signatureChecks;
}
const out={passed:true,protocolSha256:sha(protocolBytes),poolManifestSha256:sha(manifestBytes),codeSha256:sha(fs.readFileSync('scripts/trace-datasets/audit-v635-confirmation.ts')),selectionHashes:Object.fromEntries(reports.map(r=>[r.name,sha(r.bytes)])),count,selectedItems,signatureChecks,scenarios:all};
fs.writeFileSync(path.join(root,'audited-metrics.json'),JSON.stringify(out));console.log(JSON.stringify({passed:true,count,selectedItems,signatureChecks}));
