import { computeCallStats } from '../fleet/call-stats';
import { buildAgentCallTree, walkTree, type AgentNode } from '../engine/observability/agent-trace';
import { projectAgentNodeExecution, findSubagentSpawnDescription, extractExplicitSkillsFromNode } from '../engine/observability/agent-execution-projection';
import { extractObservedAgentNames, getFrameworkPrimaryAgentName } from '../engine/observability/agent-registration';
import { buildFaultPathSteps } from '../engine/observability/fault-path';
import { clusterErrorSteps, type StructuredTraceErrors } from '../engine/quality-monitoring/problem-summary';

type Row = Record<string, unknown>;
const STRINGS = ['id','taskId','user','timestamp','query','agentName','framework','model','parentExecutionId','rootExecutionId','skill','observedAgents','failures','invokedSkills','skillIssues','clientId','hostIp','hostName','observedIp','sessionEndTime','sessionLabel','endpoint'] as const;
const NUMBERS = ['skillVersion','latency','tokens','inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','reasoningTokens','maxSingleCallTokens','cost','toolCallCount','toolCallErrorCount','llmCallCount','skillTriggerRate'] as const;
export type AnalyticsExecution = { [K in Exclude<typeof STRINGS[number],'endpoint'>]: string | null } & {endpoint?:string|null} & { [K in typeof NUMBERS[number]]: number | null } & {
  id: string; taskId: string; timestamp: string; isSubagent: boolean; isAnswerCorrect: boolean | null;
  latencyMs: number | null; callStats: string | null; executionSkills: {skillName: string; version: number | null}[];
};
export interface AnalyticsProjection {
  version: 1;
  executions: AnalyticsExecution[];
  collaboration: {candidate: boolean; startTime: string | null; edges: [string,string][]; children?:{executionId:string;candidate:boolean;startTime:string|null;edges:[string,string][]}[]};
  errors: StructuredTraceErrors[];
  provenance: {snapshot_hash: string};
}
function fail(message: string): never { throw Object.assign(new Error(message), {status: 503}); }
function edgesOf(node: AgentNode, out: [string,string][]): void {
  for (const child of node.children) {
    if (node.agentName && child.agentName && node.agentName !== child.agentName) out.push([node.agentName, child.agentName]);
    edgesOf(child, out);
  }
}
export function buildAnalyticsProjection(input: {evidence: {snapshot_hash: string; execution: Row; session: Row | null}; summary?: Row}): AnalyticsProjection {
  const {evidence} = input;
  const source = evidence.execution;
  if (typeof source.id !== 'string' || typeof source.taskId !== 'string' || typeof source.timestamp !== 'string' || !Number.isFinite(Date.parse(source.timestamp))) fail('Analytics execution identity or timestamp unavailable');
  const session=evidence.session || {};
  const interactions = Array.isArray(session.interactions) ? session.interactions : [];
  const row = {} as AnalyticsExecution;
  for (const key of STRINGS) {
    const value = source[key];
    (row as Record<string, unknown>)[key] = typeof value === 'string' ? value : value == null ? null : JSON.stringify(value);
  }
  row.id = source.id; row.taskId = source.taskId; row.timestamp = source.timestamp;
  row.sessionEndTime=typeof session.endTime==='string'?session.endTime:null;
  row.sessionLabel=typeof session.label==='string'?session.label:null;
  for (const key of NUMBERS) row[key] = typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] as number : null;
  const summary = input.summary || {};
  let attrs:Row={};
  if(typeof summary.attributes_json==='string') {try{attrs=JSON.parse(summary.attributes_json);}catch{fail('Analytics source metrics unavailable');}}
  if(source.model===undefined&&typeof attrs.model==='string')row.model=attrs.model;
  if(source.observedAgents===undefined)row.observedAgents=JSON.stringify(Array.isArray(attrs.agents)?attrs.agents:extractObservedAgentNames(interactions,row.agentName));
  if(source.invokedSkills===undefined&&Array.isArray(attrs.invoked_skills))row.invokedSkills=JSON.stringify(attrs.invoked_skills);
  if(source.isSubagent===undefined&&typeof attrs.is_subagent==='boolean')row.isSubagent=attrs.is_subagent;
  for(const [key,column] of [['parentExecutionId','parent_execution_id'],['rootExecutionId','root_execution_id']] as const)if(source[key]===undefined&&typeof attrs[column]==='string')row[key]=attrs[column];
  if(source.toolCallErrorCount===undefined&&attrs.tool_error_count!=null&&Number.isFinite(Number(attrs.tool_error_count)))row.toolCallErrorCount=Number(attrs.tool_error_count);
  const mappings: Partial<Record<typeof NUMBERS[number], string>> = {inputTokens:'input_tokens',outputTokens:'output_tokens',toolCallCount:'tool_call_count',llmCallCount:'llm_call_count'};
  for (const [key, column] of Object.entries(mappings)) {
    if (source[key] !== undefined) continue;
    const value = summary[column];
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) row[key as typeof NUMBERS[number]] = Number(value);
  }
  if (source.latency === undefined && summary.started_at_ms != null && summary.ended_at_ms != null) row.latency = Math.max(0, Number(summary.ended_at_ms) - Number(summary.started_at_ms));
  if (source.tokens === undefined && row.inputTokens !== null && row.outputTokens !== null) row.tokens = row.inputTokens + row.outputTokens;
  row.latencyMs = row.latency;
  row.isSubagent = source.isSubagent === true || source.isSubagent===undefined&&attrs.is_subagent===true;
  row.isAnswerCorrect = typeof source.isAnswerCorrect === 'boolean' ? source.isAnswerCorrect : null;
  row.callStats = source.callStats===null ? null : typeof source.callStats === 'string' ? source.callStats : source.callStats&&typeof source.callStats==='object'?JSON.stringify(source.callStats):JSON.stringify(computeCallStats(interactions, {fallbackModel: row.model, failures: row.failures}));
  row.executionSkills = [];
  if (Array.isArray(source.executionSkills)) for (const raw of source.executionSkills) {
    if (!raw || typeof raw !== 'object') fail('Analytics Skill relation unavailable');
    const skill = raw as Row;
    const name = skill.skillName ?? skill.name;
    if (typeof name !== 'string' || !name) fail('Analytics Skill relation name unavailable');
    row.executionSkills.push({skillName: name, version: typeof skill.version === 'number' ? skill.version : null});
  }
  if(source.executionSkills===undefined&&row.invokedSkills) {
    let skills:unknown;try{skills=JSON.parse(row.invokedSkills);}catch{fail('Analytics Skill snapshot is invalid');}
    if(Array.isArray(skills))for(const raw of skills) {
      const name=typeof raw==='string'?raw:(raw as Row)?.name;
      if(typeof name==='string'&&name)row.executionSkills.push({skillName:name,version:typeof (raw as Row)?.version==='number'?(raw as Row).version as number:null});
    }
  }
  const structured = clusterErrorSteps([{executionId: row.id, steps: buildFaultPathSteps(interactions, 'zh')}]);
  const errors: StructuredTraceErrors[] = [{executionId: row.id, clusters: structured.clusters.map(cluster => ({key:cluster.key,node:cluster.node,errorCode:cluster.errorCode,object:cluster.object,count:cluster.count,attribution:cluster.attribution}))}];
  const candidate = /subagent|build_team|coordinator/.test(JSON.stringify(interactions));
  const edges: [string,string][] = [];
  if (candidate) {const tree = buildAgentCallTree(interactions as Parameters<typeof buildAgentCallTree>[0]); if (tree) edgesOf(tree, edges);}
  const rawStart = session.startTime;
  const startTime = (typeof rawStart === 'string' || typeof rawStart === 'number') && Number.isFinite(new Date(rawStart).getTime()) ? new Date(rawStart).toISOString() : null;
  const executions=[row];
  const childSessions:NonNullable<AnalyticsProjection['collaboration']['children']>=[];
  if (!row.isSubagent) {
    const tree=buildAgentCallTree(interactions as Parameters<typeof buildAgentCallTree>[0]);
    if (tree) {
      const children:AgentNode[]=[];const seen=new Set<string>();
      walkTree(tree,node=>{const sid=node.sessionId?.trim();if(node.depth>0&&sid&&sid!==row.taskId&&!seen.has(sid)){seen.add(sid);children.push(node);}});
      children.sort((a,b)=>a.depth-b.depth);
      const parents=new Map([[tree.id,row.id]]);
      for(const node of children) {
        const parent=parents.get(node.parentId||'')||row.id;const id=parent+'__sub__'+node.sessionId;parents.set(node.id,id);
        const own=projectAgentNodeExecution(node,interactions);
        const indices=new Set<number>();walkTree(node,child=>{for(const index of child.interactionIndices||[])indices.add(index);});
        const turns=[...indices].sort((a,b)=>a-b).map(index=>interactions[index]).filter(Boolean);
        const skills=extractExplicitSkillsFromNode(node);
        const agentName=node.agentName||getFrameworkPrimaryAgentName(row.framework)||null;
        const child:AnalyticsExecution={...row,...own,endpoint:null,id,taskId:node.sessionId,parentExecutionId:parent,rootExecutionId:row.id,isSubagent:true,agentName,query:(findSubagentSpawnDescription(interactions,node.sessionId)||own.query).slice(0,500),timestamp:node.startedAt?new Date(node.startedAt).toISOString():row.timestamp,latencyMs:own.latency,callStats:null,failures:null,isAnswerCorrect:null,cost:null,maxSingleCallTokens:null,skill:null,skillVersion:null,skillTriggerRate:null,skillIssues:null,observedAgents:JSON.stringify(extractObservedAgentNames(turns,agentName)),invokedSkills:skills.length?JSON.stringify(skills):null,executionSkills:skills.map(skill=>({skillName:skill.name,version:skill.version}))};
        // Only compact fields are published; the pure legacy projection also returns the final body.
        delete (child as unknown as Row).finalResult;
        executions.push(child);
        const childCandidate=/subagent|build_team|coordinator/.test(JSON.stringify(turns));
        const childEdges:[string,string][]=[];
        if(childCandidate){const childTree=buildAgentCallTree(turns as Parameters<typeof buildAgentCallTree>[0]);if(childTree)edgesOf(childTree,childEdges);}
        childSessions.push({executionId:id,candidate:childCandidate,startTime:child.timestamp,edges:childEdges});
      }
    }
  }
  const snapshot=evidence.snapshot_hash;
  if(!/^[0-9a-f]{64}$/.test(snapshot))fail('Analytics snapshot identity unavailable');
  const value: AnalyticsProjection = {version: 1, executions, errors, collaboration: {candidate, startTime, edges,...(childSessions.length?{children:childSessions}:{})}, provenance: {snapshot_hash: snapshot}};
  if (Buffer.byteLength(JSON.stringify(value),'utf8') > 2*1024*1024) throw Object.assign(new Error('Analytics projection exceeds byte budget'),{status:413});
  return value;
}
