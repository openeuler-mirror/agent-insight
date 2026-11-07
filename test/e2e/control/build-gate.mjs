import {blockedReport} from './worker-core.mjs';
export async function gateProductionBuild(options,{build,run}) {
 let productionBuild;
 try { productionBuild=await build(options); }
 catch { productionBuild={status:'BLOCKED',reason:'生产编译环境准备或产物导出失败，查看受限编译日志'}; }
 if(productionBuild.status!=='PASS') {
  const report=blockedReport(options.job,'生产编译未通过，未执行后续 UT/E2E',options.testedSha);
  report.status=productionBuild.status==='FAIL'?'FAIL':'BLOCKED';
  report.productionBuild=productionBuild;report.startedAt=productionBuild.startedAt||report.startedAt;
  for(const row of report.scenarios)row.status='NOT_RUN';
  return report;
 }
 let report;try{report=await run({...options,productionBuild});}catch{report=blockedReport(options.job,'执行结果汇总失败，查看分组报告与受限日志',options.testedSha);report.npmTest={status:'BLOCKED',fullSuiteComplete:false,reason:'无法确认UT执行结果，查看分组报告'};}
 const {artifactDirectory,...publicBuild}=productionBuild;report.productionBuild=publicBuild;report.startedAt=productionBuild.startedAt||report.startedAt;return report;
}
