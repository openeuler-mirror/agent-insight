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
 assert.equal(harness({step:1,traceMode:'existing'}).ticks.length,1);assert.equal(harness({step:1,environmentBusy:true}).ticks.length,0);
});
