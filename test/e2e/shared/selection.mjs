import {cases} from './catalog.mjs';
export function selectedCases(profile){
 if(profile!==undefined&&profile!=='core-five')throw Error('Unknown execution profile');
 return cases.filter(c=>profile!=='core-five'||c.id!=='006').map(c=>c.id);
}
export function assertSelection(report,profile,caseId,configured){
 if(caseId&&!cases.some(c=>c.id===caseId))throw Error('Unknown case');
 const selected=caseId?[caseId]:configured||selectedCases(profile);
 if((profile||configured||report.selected)&&JSON.stringify(report.selected)!==JSON.stringify(selected))throw Error('Report selection differs from trusted profile');
 for(const row of report.scenarios||[])if(!selected.includes(row.id)&&(row.status!=='NOT_RUN'||row.stages?.length))throw Error('Execution of excluded scenario');
 return selected;
}
