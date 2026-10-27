import { lengthBucket, type Candidate, type Policy, type Selection } from './index';
import { type AgreementFeatures } from './answer-consensus';

const tv = (counts: number[], size: number, pool: number[]) => counts.reduce((n,v,i) => n + Math.abs(v/size-pool[i]),0)/2;

export function* supportedImproveSteps(candidates:Candidate[], initial:Selection[], features:AgreementFeatures, settings:{tokenBudget:number;distributionEnabled:boolean}, supports:(oldKey:string,newKey:string)=>boolean) {
  const byKey=new Map(candidates.map(c=>[c.key,c])), vocabulary=new Map<string,number>();
  const taskNames=[...new Set(candidates.map(c=>c.task))].sort();if(!taskNames.includes('unknown'))taskNames.push('unknown');
  let work=0;
  const groups:{key:string;rows:Candidate[];terms:Uint32Array;cost:number;bucket:number;task:number}[]=[];
  for(const [key,rows] of [...features.groups].sort(([a],[b])=>a.localeCompare(b))) {
    const terms:number[]=[];
    for(const term of rows[0].lexical!.terms) {if(!vocabulary.has(term))vocabulary.set(term,vocabulary.size);terms.push(vocabulary.get(term)!);if(++work%1024===0)yield;}
    const tasks=[...new Set(rows.map(r=>r.task).filter(t=>t!=='unknown'))];
    groups.push({key,rows:[...rows].sort((a,b)=>features.scores.get(b.key)!-features.scores.get(a.key)!||a.key.localeCompare(b.key)),terms:Uint32Array.from(terms),cost:rows[0].lexical!.tokenCount,bucket:lengthBucket(rows[0].lexical!.tokenCount),task:taskNames.indexOf(tasks.length===1?tasks[0]:'unknown')});
  }
  const byInput=new Map(groups.map((g,i)=>[g.key,i])),groupOf=(s:Selection)=>byInput.get(byKey.get(s.key)!.inputKey)!;
  const requiredTasks=new Set(initial.map(s=>groups[groupOf(s)].task)),requiredCells=new Set(initial.flatMap(s=>s.path.cells));
  const poolBuckets=[0,0,0,0],poolTasks=taskNames.map(()=>0);
  for(const g of groups){poolBuckets[g.bucket]++;poolTasks[g.task]++;}
  const bucketDistribution=poolBuckets.map(n=>n/groups.length),taskDistribution=poolTasks.map(n=>n/groups.length);
  const refs=new Int32Array(vocabulary.size),owners=new Int32Array(vocabulary.size),counts=new Int32Array(groups.length),losses=new Int32Array(initial.length),recovered=new Int32Array(initial.length);
  const selected=[...initial],initialTerms=new Set<number>();let cost=0;
  for(const s of initial){const g=groups[groupOf(s)];cost+=g.cost;for(const t of g.terms){initialTerms.add(t);if(++work%1024===0)yield;}}
  if(cost>settings.tokenBudget)throw new Error('INFEASIBLE_START');
  const coverageFloor=initialTerms.size,initialScore=initial.reduce((n,s)=>n+features.scores.get(s.key)!,0);
  let coverage=coverageFloor,passes=0,swaps=0;
  for(let pass=0;pass<Math.min(16,initial.length);pass++) {
    passes++;refs.fill(0);owners.fill(-1);counts.fill(0);losses.fill(0);
    const buckets=[0,0,0,0],tasks=taskNames.map(()=>0),cells=new Map<string,number>();
    for(const s of selected){const i=groupOf(s),g=groups[i];if(counts[i]++===0){buckets[g.bucket]++;tasks[g.task]++;}for(const t of g.terms){refs[t]++;if(++work%1024===0)yield;}for(const c of new Set(s.path.cells))cells.set(c,(cells.get(c)||0)+1);}
    const unique=counts.reduce((n,c)=>n+Number(c>0),0),lengthLimit=Math.max(.1,2/unique),taskLimit=Math.max(.2,2/unique);
    const outgoing=selected.map((s,index)=>({selection:s,index,group:groupOf(s),score:features.scores.get(s.key)!})).sort((a,b)=>a.selection.key.localeCompare(b.selection.key));
    for(let j=0;j<outgoing.length;j++)for(const t of groups[outgoing[j].group].terms){if(refs[t]===1){owners[t]=j;losses[j]++;}if(++work%1024===0)yield;}
    const distributionCache=new Map<number,boolean>();
    const allowed=(a:typeof groups[number],b:typeof groups[number])=>{
      const key=((a.bucket*4+b.bucket)*taskNames.length+a.task)*taskNames.length+b.task;
      let value=distributionCache.get(key);
      if(value===undefined){const bs=buckets.map((n,i)=>n-Number(i===a.bucket)+Number(i===b.bucket)),ts=tasks.map((n,i)=>n-Number(i===a.task)+Number(i===b.task));value=[...requiredTasks].every(t=>ts[t]>0)&&(!settings.distributionEnabled||(tv(bs,unique,bucketDistribution)<=lengthLimit+1e-9&&tv(ts,unique,taskDistribution)<=taskLimit+1e-9));distributionCache.set(key,value);}
      return value;
    };
    type Proposal={incoming:Selection;group:number;outgoing:number;oldKey:string;gain:number;saving:number;proxyGain:number};
    const scan=(i:number,added:number,current:Proposal|undefined)=>{
      const g=groups[i];let best=current;
      for(let j=0;j<outgoing.length;j++){
        const old=outgoing[j],previous=groups[old.group];if(counts[old.group]!==1)continue;
        const ceiling=features.scores.get(g.rows[0].key)!-old.score;if(ceiling<=0||(best&&ceiling<best.proxyGain))continue;
        const gain=added-losses[j]+recovered[j],saving=previous.cost-g.cost;
        if(coverage+gain<coverageFloor||cost-saving>settings.tokenBudget||!allowed(previous,g))continue;
        const lost=[...requiredCells].filter(c=>(cells.get(c)||0)===1&&old.selection.path.cells.includes(c));
        let incoming:Selection|undefined;
        for(const row of g.rows){if(features.scores.get(row.key)!<=old.score)break;if(!supports(old.selection.key,row.key))continue;const path=[...row.paths].sort((a,b)=>b.knownDimensions-a.knownDimensions||a.key.localeCompare(b.key)).find(p=>lost.every(c=>p.cells.includes(c)));if(path){incoming={key:row.key,path,reason:'proxy_quality_exchange'};break;}}
        if(!incoming)continue;
        const proxyGain=features.scores.get(incoming.key)!-old.score;
        const tie=best&&(g.key.localeCompare(groups[best.group].key)||incoming.key.localeCompare(best.incoming.key)||old.selection.key.localeCompare(best.oldKey));
        if(best&&(proxyGain<best.proxyGain||(proxyGain===best.proxyGain&&(gain<best.gain||(gain===best.gain&&(saving<best.saving||(saving===best.saving&&tie! >= 0)))))))continue;
        best={incoming,group:i,outgoing:old.index,oldKey:old.selection.key,gain,saving,proxyGain};
      }
      return best;
    };
    let best:Proposal|undefined;
    const minimum=Math.min(...outgoing.filter(o=>counts[o.group]===1).map(o=>o.score));
    const small=(i:number)=>{recovered.fill(0);let added=0;for(const t of groups[i].terms){added+=Number(refs[t]===0);if(owners[t]>=0)recovered[owners[t]]++;}return scan(i,added,best);};
    for(let i=0;i<groups.length;i++){
      if(counts[i]||features.scores.get(groups[i].rows[0].key)!<=minimum)continue;
      if(groups[i].terms.length<=1024)best=small(i);
      else{recovered.fill(0);let added=0;for(const t of groups[i].terms){added+=Number(refs[t]===0);if(owners[t]>=0)recovered[owners[t]]++;if(++work%1024===0)yield;}best=scan(i,added,best);}
      if(i%8===0)yield;
    }
    if(!best)break;
    selected[best.outgoing]=best.incoming;coverage+=best.gain;cost-=best.saving;swaps++;
  }
  const unique=new Set(selected.map(groupOf)),buckets=[0,0,0,0],tasks=taskNames.map(()=>0);
  for(const i of unique){buckets[groups[i].bucket]++;tasks[groups[i].task]++;}
  return {selected,vocabulary:coverage,tokens:cost,lengthTV:tv(buckets,unique.size,bucketDistribution),taskTV:tv(tasks,unique.size,taskDistribution),proxy:{passes,swaps,coverageFloor,initialScore,finalScore:selected.reduce((n,s)=>n+features.scores.get(s.key)!,0)}};
}
