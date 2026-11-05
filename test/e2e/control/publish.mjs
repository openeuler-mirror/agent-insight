import {assertSelection} from '../shared/selection.mjs';
import { renderSummary } from '../shared/suite.mjs';
import {assertProbeReport,renderProbe} from './probe.mjs';

export async function publishResult(api,job,report,{reportUrl}={}){
  if(report.dirtyWorkingTree)throw Error('Refusing to publish dirty working-tree result as a PR check');
  const probe=job.mode==='probe'||report.kind==='pipeline-probe';
  if(probe)assertProbeReport(report,job);else assertSelection(report,job.profile,undefined,job.caseIds);
  if(report.scenarios?.length!==6||new Set(report.scenarios.map(s=>s.id)).size!==6)throw Error('Expected six scenario results');
  const current=await api.readPull(job.repository,job.pr);
  if(!['open','opened'].includes(current.state)||current.head?.sha!==job.headSha||current.base?.sha!==job.baseSha)return {status:'STALE'};
  const marker=`<!-- agent-insight-e2e:${job.id} -->`;
  const route=api.repoPath(job.repository)+'/pulls/'+job.pr+'/comments';
  let body=`${marker}\n源提交：${job.headSha}\n目标提交：${job.baseSha}\n\n${probe?renderProbe(report,job).markdown:renderSummary(report).markdown}`;
  if(reportUrl){const url=new URL(reportUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('Report URL must be credential-free HTTPS');body+=`\n\n[完整报告](${url.href})`;}
  const findComment=async predicate=>{
    for(let page=1;page<=20;page++){
      const comments=await api.request('GET',route+'?per_page=100&page='+page);
      const found=comments.find(predicate);if(found)return found;
      if(comments.length<100)return;
    }
    throw Error('Comment history exceeds bounded deduplication window');
  };
  const existing=await findComment(c=>c.body?.includes(marker));
  if(existing){if(existing.body!==body)throw Error('Existing comment read-back mismatch');return {status:'ALREADY_PUBLISHED',commentId:existing.id};}
  const latest=await api.readPull(job.repository,job.pr);
  if(!['open','opened'].includes(latest.state)||latest.head?.sha!==job.headSha||latest.base?.sha!==job.baseSha)return {status:'STALE'};
  const result=await api.createComment(job.repository,job.pr,body);
  if(!result?.id||result.body!==body)throw Error('Comment creation response did not confirm exact body');
  const commentId=result.note_id??result.id;
  const saved=await findComment(c=>String(c.id)===String(commentId));
  if(saved?.body!==body)throw Error('Comment read-back mismatch');
  return {status:'PUBLISHED',commentId:saved.id};
}
