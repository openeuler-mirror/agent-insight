type DatasetSelection={id:string;content:{cases:Array<{id:string}>}};
export function caseSelectionForVersion(dataset:DatasetSelection|undefined,saved?:{datasetId:string;caseIds?:string[]}){
 const all=dataset?.content.cases.map(c=>c.id)||[];
 return saved?.datasetId===dataset?.id&&saved?.caseIds?saved.caseIds.filter(id=>all.includes(id)):all;
}

export function failedCheckRows<T>(rows: T[], results: Array<{checks: Array<{name: string; verdict: string}>}>, name: string): T[] {
  return rows.filter((_, index) => results[index]?.checks.some(check => check.name === name && check.verdict === 'fail'));
}
