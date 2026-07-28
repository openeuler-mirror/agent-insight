import { SpoolReader, SpoolEvent } from "./trae-collector/src/uploader/spool"
import * as os from "os"; import * as path from "path"
const H="http://localhost:3000",K="sk-5fd458378ebb089b3d135557939bb4ec"
const D=path.join(os.homedir(),".agent-insight","otel_data","trae")

function buildPayload(sid:string,evts:SpoolEvent[],st:any):any{
  const se=evts.find(e=>e.kind==='agent.session.start'||e.kind==='agent.subagent.start')
  const pms=(st?.prompts?.length>0)?st.prompts:evts.filter(e=>e.kind==='agent.prompt')
  const eds=(st?.ends?.length>0)?st.ends:evts.filter(e=>e.kind==='agent.response')
  const le=eds[eds.length-1]||null
  const tcs=evts.filter(e=>e.kind==='tool.call.start')
  const trs=evts.filter(e=>e.kind==='tool.call.end')
  const llms=evts.filter(e=>e.kind==='llm.call')
  let lat=0
  if(se&&le){const s=new Date(se.t).getTime(),e2=new Date(le.t).getTime();if(e2>s)lat=e2-s}
  const tl:Record<string,number>={}
  for(const ts of tcs){const id=ts.trace_id;if(!id)continue;const te=trs.find(e=>e.trace_id===id);if(te){const s=new Date(ts.t).getTime(),e=new Date(te.t).getTime();if(e>s)tl[id]=e-s}}
  const tcfa=tcs.map(ts=>{const te=trs.find(r=>r.trace_id===ts.trace_id);return{id:ts.trace_id||'',type:'function',function:{name:ts.payload?.toolName||te?.payload?.toolName||'',arguments:JSON.stringify(ts.payload?.toolInput||{})},state:te?.payload?.error?'error':'success',output:te?.payload?.toolResponse||null,error:te?.payload?.error||null,duration_ms:tl[ts.trace_id||'']||void 0,timing:{started_at:ts.t,completed_at:te?.t||ts.t}}})
  const fl=llms[0]?.payload
  const apt=pms.map((p:any)=>p.payload?.query||'').filter(Boolean)
  const art=eds.map((e:any)=>e.payload?.finalResult||'').filter(Boolean)
  const cp=apt.join(' '),cr=art.join(' ')
  const hld=llms.length>0&&(fl?.tokens||fl?.totalTokens)
  const est=hld?void 0:{input:Math.max(1,Math.ceil((cp.match(/[\u3400-\u9fff]/g)||[]).length*1.2+((cp.replace(/[\u3400-\u9fff]/g,'').match(/[A-Za-z0-9_]+/g)||[]).length)*1.3+(cp.replace(/[A-Za-z0-9_\s\u3400-\u9fff]/g,'').length)*0.5)),output:Math.max(1,Math.ceil((cr.match(/[\u3400-\u9fff]/g)||[]).length*1.2+((cr.replace(/[\u3400-\u9fff]/g,'').match(/[A-Za-z0-9_]+/g)||[]).length)*1.3+(cr.replace(/[A-Za-z0-9_\s\u3400-\u9fff]/g,'').length)*0.5)),total:0,estimated:true}
  if(est){est.total=est.input+est.output}
  const ut=fl?{input:fl.promptTokens||0,output:fl.completionTokens||0,total:fl.totalTokens||(fl.promptTokens||0)+(fl.completionTokens||0)}:est
  const tt=fl?(fl.tokens||fl.totalTokens||0):(est?.total||0)
  const sa=se?.agent_id||pms.find((p:any)=>p?.agent_id)?.agent_id||eds.find((e:any)=>e?.agent_id)?.agent_id||'solo_agent'
  const its:any[]=[];const mt=Math.max(pms.length,eds.length)
  for(let i=0;i<mt;i++){
    if(pms[i])its.push({role:'user',content:pms[i].payload?.query||'',timeInfo:{created:new Date(pms[i].t).getTime(),completed:new Date(pms[i].t).getTime()},agent:sa,agentName:sa})
    if(eds[i]){
      const ttt=tcfa.filter(tc=>{const ts=tcs.find(s=>s.trace_id===tc.id);if(!ts)return false;const s2=pms[i]?.t||'0001-01-01';const e2=eds[i]?.t||'9999-12-31';return ts.t>=s2&&ts.t<=e2})
      // split main vs subagent
      const mt2:any[]=[],sg=new Map<string,{id:string,type:string,tools:any[]}>()
      for(const tc of ttt){const ts2=tcs.find(s=>s.trace_id===tc.id);const sai=ts2?.payload?.subagentId;if(sai){if(!sg.has(sai))sg.set(sai,{id:sai,type:ts2?.payload?.subagentType||'',tools:[]});sg.get(sai)!.tools.push(tc)}else mt2.push(tc)}
      for(const[sai,v]of sg){mt2.push({id:'task_'+sai,type:'function',function:{name:'task',arguments:JSON.stringify({subagent_type:v.type,description:v.id})},state:'success',output:JSON.stringify({subagent_session_id:sid+'__'+v.id}),timing:{started_at:v.tools[0]?.timing?.started_at||eds[i].t,completed_at:v.tools[v.tools.length-1]?.timing?.completed_at||eds[i].t},trace_split_parallel_task:true})}
      its.push({role:'assistant',content:eds[i].payload?.finalResult||'',timeInfo:{created:new Date(eds[i].t).getTime(),completed:new Date(eds[i].t).getTime()},agent:sa,agentName:sa,model:fl?.model||'',usage:ut,finish_reason:'stop',tool_calls:mt2.length>0?mt2:void 0})
      for(const[sai,v]of sg){its.push({role:'subagent',content:'',timeInfo:{created:new Date(v.tools[0]?.timing?.started_at||eds[i].t).getTime(),completed:new Date(v.tools[v.tools.length-1]?.timing?.completed_at||eds[i].t).getTime()},agent:sa,subagent_name:v.type,subagent_session_id:sid+'__'+v.id,model:fl?.model||'',tool_calls:v.tools})}
    }
  }
  const scs=trs.filter(t=>{const sm=tcs.find(s=>s.trace_id===t.trace_id);return(t.payload?.toolType==='skill'||t.payload?.toolName==='Skill'||sm?.payload?.toolName==='Skill')})
  let ti=0,to=0;for(const lc of llms){ti+=lc.payload?.promptTokens||0;to+=lc.payload?.completionTokens||0}
  if(ti===0&&to===0&&est){ti=est.input||0;to=est.output||0}
  const sn=scs.map(s=>{const se2=tcs.find(ts=>ts.trace_id===s.trace_id);return s.payload?.skillName||se2?.payload?.skillName||''}).filter(Boolean)
  return{task_id:sid,query:cp,framework:'trae',agent_id:se?.agent_id||'',agent_type:se?.agent_type||'',agent:sa,agentName:sa,model:fl?.model||'',tokens:tt,input_tokens:ti,output_tokens:to,latency:lat/1000,final_result:cr,timestamp:new Date().toISOString(),completed:eds.length>0,trace_completed_at:eds.length>0?new Date().toISOString():void 0,tool_call_count:tcs.length,tool_call_error_count:trs.filter(t=>t.payload.error).length,llm_call_count:llms.length,tool_latencies:tl,interactions:its,skill:sn[0]||void 0,skills:sn.length>0?sn:void 0,parent_session_id:se?.payload?.parent_session_id||se?.parent_id||'',subagent:se?.kind==='agent.subagent.start',skill_calls:scs.map(s=>{const se2=tcs.find(ts=>ts.trace_id===s.trace_id);return{skillName:s.payload?.skillName||se2?.payload?.skillName||s.payload?.toolName||'',toolType:'skill',error:!!s.payload?.error}})}
}

async function main(){
  const r=new SpoolReader(D),ae:SpoolEvent[]=[]
  for(const f of r.listJsonlFiles())ae.push(...r.readEvents(f))
  const ss=r.buildSessionState(ae);let d=0
  const tp=['test','session-main','session-llm','session-provider','session-switch','session-empty']
  for(const[sid,st]of ss){
    if(tp.some(p=>sid.startsWith(p))||(st.prompts.length===0&&st.ends.length===0))continue
    const se2:SpoolEvent[]=[st.start,...st.prompts,...st.tools,...st.ends,...st.llms].filter((e):e is SpoolEvent=>e!==null)
    const pl=buildPayload(sid,se2,st)
    if(st.subSessions.length>0)pl.sub_sessions=st.subSessions
    const roles=pl.interactions.map((m:any)=>m.role)
    const subCount=roles.filter((r:string)=>r==='subagent').length
    try{
      const res=await fetch(`${H}/api/ingest/upload`,{method:'POST',headers:{'Content-Type':'application/json','x-witty-api-key':K},body:JSON.stringify(pl)})
      const body=await res.text()
      if(res.ok){d++;console.log(`✅ ${sid.slice(0,14)} ints=${pl.interactions.length} subs=${subCount}`)}
      else{console.log(`❌ ${sid.slice(0,14)} HTTP${res.status}`)}
    }catch(e:any){console.log(`❌ ${sid.slice(0,14)} ${e.message}`)}
  }
  console.log(`\nDone: ${d}`)
}
main()
