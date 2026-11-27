export function deriveRootSshTruth(text){
 const lines=text?text.split(/\r?\n/):[];if(lines.at(-1)==='')lines.pop();const counts=new Map();let rootFailures=0;
 for(const line of lines){if(!line.includes('authentication failure;')||!/(?:^|\s)user=root(?:\s|$)/.test(line))continue;rootFailures++;const host=line.match(/(?:^|\s)rhost=(\S+)/)?.[1];if(host)counts.set(host,(counts.get(host)||0)+1);}
 const topSources=[...counts].sort((a,b)=>b[1]-a[1]);return {totalLines:lines.length,rootFailures,sourceCount:counts.size,sources:Object.fromEntries(counts),topSources};
}
export function findReferenceInconsistencies(reference,truth){
 const rows=reference.replaceAll('\\n','\n').replaceAll('\\t','\t').split('\n'),issues=[];
 for(const row of rows){const match=row.trim().match(/^([A-Za-z0-9][A-Za-z0-9.:_-]*)[ \t]+(\d+)(?:[ \t]*次)?$/);if(!match)continue;const [source,claimed]=[match[1],Number(match[2])],actual=Object.hasOwn(truth.sources,source)?truth.sources[source]:0;if(claimed!==actual)issues.push({source,claimed,actual});}
 return issues;
}
