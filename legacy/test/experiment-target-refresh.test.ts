import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source=fs.readFileSync(new URL('../src/components/eval/ExperimentWizard.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('ExperimentWizard.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect:ts.Node|undefined;
function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes('window.setInterval')&&node.arguments[0].getText(ast).includes('refreshAgents'))effect=node.arguments[0];ts.forEachChild(node,visit);}
visit(ast);assert.ok(effect);
const compiled=ts.transpileModule(`const effect=(${effect.getText(ast)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness({step=2,traceMode='generate',isBenchmarkDataset=false,environmentBusy=false,user='test@example.com'}={}){
 const ticks:Array<()=>void>=[],focus=new Set<()=>void>();let reads=0,cleared=0;
 const window={setInterval:(cb:()=>void,ms:number)=>{assert.equal(ms,10000);ticks.push(cb);return 1;},clearInterval:()=>{cleared++;},addEventListener:(event:string,cb:()=>void)=>{assert.equal(event,'focus');focus.add(cb);},removeEventListener:(_event:string,cb:()=>void)=>{focus.delete(cb);}};
 const refreshAgents=async()=>{reads++;return [];};
 const run=new Function('window','user','environmentBusy','step','isBenchmarkDataset','traceMode','refreshAgents',`${compiled}\nreturn effect;`)(window,user,environmentBusy,step,isBenchmarkDataset,traceMode,refreshAgents);
 const cleanup=run();return {ticks,focus,cleanup,state:()=>({reads,cleared})};
}
for(const isBenchmarkDataset of [false,true])test(`生成 Trace 第 2 步持续刷新真实能力（Benchmark=${isBenchmarkDataset}）`,()=>{
 const h=harness({isBenchmarkDataset});assert.equal(h.ticks.length,1);h.ticks[0]();for(const cb of h.focus)cb();assert.equal(h.state().reads,2);h.cleanup();assert.equal(h.state().cleared,1);assert.equal(h.focus.size,0);
});
test('已有 Trace、后续步骤和环境准备锁定时不重新刷新目标',()=>{
 for(const value of [{traceMode:'existing'},{step:3},{environmentBusy:true},{user:''}])assert.equal(harness(value).ticks.length,0);
});
test('第 1 步保留现有刷新，环境准备时仍暂停',()=>{
 assert.match(source,/当前 Agent 已不在最新候选中，请重新选择/);
 assert.equal(harness({step:1,traceMode:'existing'}).ticks.length,1);assert.equal(harness({step:1,environmentBusy:true}).ticks.length,0);
});

let refreshSource:ts.ArrowFunction|ts.FunctionExpression|undefined;
function visitRefresh(node:ts.Node){
 const initializer=ts.isVariableDeclaration(node)?node.initializer:undefined;
 if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='refreshAgents'&&initializer&&ts.isCallExpression(initializer)&&initializer.expression.getText(ast)==='useCallback'){
  const fn=initializer.arguments[0];if(fn&&(ts.isArrowFunction(fn)||ts.isFunctionExpression(fn)))refreshSource=fn;
 }
 ts.forEachChild(node,visitRefresh);
}
visitRefresh(ast);assert.ok(refreshSource);
const refreshCompiled=ts.transpileModule(`const refreshAgents=(${refreshSource.getText(ast)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
type AgentListResponse={ok:boolean;json:()=>Promise<unknown>};
function refreshHarness({user='test@example.com',advancing=false,fetchImpl}:{user?:string;advancing?:boolean;fetchImpl:(url:string)=>Promise<AgentListResponse>}){
 const traceAdvanceRef={current:advancing},agentsRequestIdRef={current:0};
 const state:{agents:unknown;diagnostics:unknown;reads:number;urls:string[]}={agents:null,diagnostics:null,reads:0,urls:[]};
 const apiFetch=(url:string)=>{state.reads++;state.urls.push(url);return fetchImpl(url);};
 const setAgents=(value:unknown)=>{state.agents=value;};
 const setTraceGenerationDiagnostics=(value:unknown)=>{state.diagnostics=value;};
 const refreshAgents=new Function('user','traceAdvanceRef','agentsRequestIdRef','apiFetch','setAgents','setTraceGenerationDiagnostics',`${refreshCompiled}\nreturn refreshAgents;`)(user,traceAdvanceRef,agentsRequestIdRef,apiFetch,setAgents,setTraceGenerationDiagnostics) as (confirmPreparation?:boolean)=>Promise<unknown[]>;
 return {refreshAgents,state};
}
test('Agent 刷新按请求序号丢弃过期响应',async()=>{
 const pending:Array<(value:AgentListResponse)=>void>=[];
 const h=refreshHarness({fetchImpl:()=>new Promise(resolve=>{pending.push(resolve);})});
 const first=h.refreshAgents(),second=h.refreshAgents();
 assert.equal(pending.length,2);assert.deepEqual(h.state.urls,['/api/experiments/agents?user=test%40example.com','/api/experiments/agents?user=test%40example.com']);
 pending[1]({ok:true,json:async()=>({agents:[{name:'fresh'}],traceGenerationDiagnostics:[{code:'FRESH'}]})});
 assert.deepEqual(await second,[{name:'fresh'}]);
 pending[0]({ok:true,json:async()=>({agents:[{name:'stale'}],traceGenerationDiagnostics:[{code:'STALE'}]})});
 assert.deepEqual(await first,[{name:'stale'}]);
 assert.deepEqual(h.state.agents,[{name:'fresh'}]);assert.deepEqual(h.state.diagnostics,[{code:'FRESH'}]);
});
test('提交复核期间的后台刷新不发请求，复核时强制刷新',async()=>{
 const h=refreshHarness({advancing:true,fetchImpl:async()=>({ok:true,json:async()=>({agents:[{name:'target'}]})})});
 assert.deepEqual(await h.refreshAgents(),[]);assert.equal(h.state.reads,0);assert.equal(h.state.agents,null);
 assert.deepEqual(await h.refreshAgents(true),[{name:'target'}]);assert.equal(h.state.reads,1);assert.deepEqual(h.state.agents,[{name:'target'}]);
});
test('未登录或刷新失败时不覆盖现有目标',async()=>{
 const anonymous=refreshHarness({user:'',fetchImpl:async()=>{throw new Error('不应发起请求');}});
 assert.deepEqual(await anonymous.refreshAgents(),[]);assert.equal(anonymous.state.reads,0);
 const failed=refreshHarness({fetchImpl:async()=>({ok:false,json:async()=>({})})});
 await assert.rejects(failed.refreshAgents(),/Agent 列表刷新失败/);assert.equal(failed.state.agents,null);
});
