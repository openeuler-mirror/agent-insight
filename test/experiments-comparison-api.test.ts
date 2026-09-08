// 对比实验 API 冒烟：POST 创建（type=llm + groups）→ POST 运行（type 分流）→ POST rescan。
// 覆盖：AC-002 分组落库 / AC-008 空组校验 / AC-017 增量补评 / type 缺省走单组（AC-019）。
// 落仓库 data/witty_insight.db（同 experiments-api.test.ts：钉住 DATABASE_URL）。
import path from 'node:path';
process.env.DATABASE_URL ||= `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prisma } from '@/lib/storage/prisma';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { POST as createExperiment } from '@/app/api/experiments/route';
import { GET as getExperiment } from '@/app/api/experiments/[id]/route';
import { POST as runExperiment } from '@/app/api/experiments/[id]/run/route';
import { POST as rescanExperiment } from '@/app/api/experiments/[id]/rescan/route';
import { POST as addExperimentCases } from '@/app/api/experiments/[id]/cases/route';
import { GET as getTraces } from '@/app/api/experiments/traces/route';

const TEST_USER = `cmp-api-${Date.now()}`;
const CUSTOM_LLM_ID = 'custom-cmp-api-judge';

test.before(async () => {
  await writeUserCustomEvaluators(TEST_USER, [{
    id: CUSTOM_LLM_ID, name: 'cmp-api-judge', description: '', evaluatorType: 'LLM',
    source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '',
    popularity: 0, mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'test', systemPrompt: '评估 {{output}}', userPrompt: '' },
  }]);
});

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  await prisma.customEvaluatorList.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  setJudgeLlmCallerForTest(null);
});

function postReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('AC-002: POST /api/experiments type=llm + groups → 创建实验+分组记录落库', async (t) => {
  const agent = `cmp-api-create-${Date.now()}`;
  // 为两组各建一条 trace（autoPairGroups 会查候选）
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '对比实验冒烟', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  // 验证落库
  const exp = await prisma.experiment.findUnique({ where: { id }, include: { groups: true, cases: true } });
  assert.ok(exp);
  assert.equal(exp.type, 'llm');
  assert.equal(exp.groups.length, 2);
  // autoPairGroups 已为可比配对创建 case（1 query × 2 sides = 2 cases）
  assert.equal(exp.cases.length, 2);
});

test('AC-008: POST /api/experiments 某组无候选 trace → 400 + 指明哪组', async (t) => {
  const agent = `cmp-api-empty-${Date.now()}`;
  // 只建 A 组 trace，B 组无
  const e = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model: 'glm', query: 'q1' } });
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '空组实验', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /B.*无.*trace|无.*匹配.*trace/i);
  t.after(async () => { await prisma.execution.delete({ where: { id: e.id } }).catch(() => {}); });
});

test('AC-019: POST /api/experiments 不带 type → 走单组路径（type=single）', async (t) => {
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '单组回归', agentName: 'single-agent',
    cases: [{ executionId: 'exec-1', taskId: 'task-1', input: 'q1', actualOutput: 'a1' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  t.after(async () => { await prisma.experiment.delete({ where: { id } }).catch(() => {}); });

  const exp = await prisma.experiment.findUnique({ where: { id } });
  assert.equal(exp!.type, 'single');
});

test('POST /api/experiments A/B 取值相同 → 400', async () => {
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '同值', agentName: 'same-agent',
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'glm' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 400);
});

test('POST /api/experiments/[id]/run type=llm → 分流 startComparisonRun', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-run-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '运行分流', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const runRes = await runExperiment(
    new Request(`http://localhost/api/experiments/${id}/run?user=${TEST_USER}`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(runRes.status, 200);
  const runBody = await runRes.json();
  assert.equal(runBody.status, 'running');
  // 等待后台完成（轮询 experiment.status）
  for (let i = 0; i < 30; i++) {
    const exp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
    if (exp!.status === 'done' || exp!.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalExp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
  assert.equal(finalExp!.status, 'done');
});

test('AC-017: POST /api/experiments/[id]/rescan 增量补评', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-rescan-${Date.now()}`;
  // 初始只有 A 组 trace
  const e1 = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model: 'glm', query: 'q1', skill: 's', skillVersion: 1 } });
  // create 会因 B 组无 trace 而抛 400 —— 改为先 create（用单组绕过），再手动改 type？
  // 实际流程：先建对比实验（需要两组 trace），所以这里先建两组
  const e2 = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model: 'qwen', query: 'q1', skill: 's', skillVersion: 1 } });
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '重扫测试', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: [e1.id, e2.id] } } });
  });

  // 补一条新 query 的 trace（两组都补）→ rescan 应发现新可比配对
  const e3 = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model: 'glm', query: 'q2', skill: 's', skillVersion: 1 } });
  const e4 = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model: 'qwen', query: 'q2', skill: 's', skillVersion: 1 } });
  t.after(async () => { await prisma.execution.deleteMany({ where: { id: { in: [e3.id, e4.id] } } }); });

  const rescanRes = await rescanExperiment(
    postReq(`http://localhost/api/experiments/${id}/rescan`, { user: TEST_USER }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rescanRes.status, 200);
  const body = await rescanRes.json();
  assert.ok(body.newPairsCount >= 1, `expected >=1 new pair, got ${body.newPairsCount}`);
});

test('POST /api/experiments/[id]/rescan 运行中 → 409', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-rescan409-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '重扫409', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  // 先启动运行（不 await completion）
  await runExperiment(
    new Request(`http://localhost/api/experiments/${id}/run?user=${TEST_USER}`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
  // 立即 rescan → 409
  const rescanRes = await rescanExperiment(
    postReq(`http://localhost/api/experiments/${id}/rescan`, { user: TEST_USER }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rescanRes.status, 409);
  // 等运行完成
  for (let i = 0; i < 30; i++) {
    const exp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
    if (exp!.status === 'done' || exp!.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

// ─── T006: GET /experiments/[id] extend + GET /traces model filter ───────────

test('AC-003: GET /api/experiments/[id] type=llm → 响应含 groups + pairing', async (t) => {
  const agent = `cmp-api-detail-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { user: TEST_USER,  agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '详情扩展', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${TEST_USER}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.type, 'llm');
  assert.ok(Array.isArray(detail.groups));
  assert.equal(detail.groups.length, 2);
  assert.ok(Array.isArray(detail.pairing?.items));
  assert.ok(typeof detail.pairing?.comparableRate === 'number');
});

test('GET /api/experiments/[id] type=single → 响应不含 groups/pairing（AC-019）', async (t) => {
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '单组详情', agentName: 'single-detail-agent',
    cases: [{ executionId: 'exec-s1', taskId: 'task-s1', input: 'q1', actualOutput: 'a1' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  }));
  const { id } = await createRes.json();
  t.after(async () => { await prisma.experiment.delete({ where: { id } }).catch(() => {}); });

  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${TEST_USER}`),
    { params: Promise.resolve({ id }) },
  );
  const detail = await detailRes.json();
  assert.equal(detail.type, 'single');
  assert.equal(detail.groups, undefined);
  assert.equal(detail.pairing, undefined);
});

test('GET /api/experiments/traces 加 model 过滤 + 返回 model/skill/skillVersion', async (t) => {
  const agent = `cmp-api-traces-${Date.now()}`;
  const e1 = await prisma.execution.create({ data: { user: TEST_USER, agentName: agent, model: 'glm-4.7', query: 'q1', skill: 's1', skillVersion: 1 } });
  const e2 = await prisma.execution.create({ data: { user: TEST_USER, agentName: agent, model: 'qwen3-max', query: 'q2', skill: 's2', skillVersion: 2 } });
  t.after(async () => { await prisma.execution.deleteMany({ where: { id: { in: [e1.id, e2.id] } } }); });

  // 不带 model 过滤：返回全部 + model/skill/skillVersion 字段
  const allRes = await getTraces(
    new Request(`http://localhost/api/experiments/traces?agent=${agent}&user=${TEST_USER}`),
  );
  const allBody = await allRes.json();
  assert.ok(allBody.items.length >= 2);
  const first = allBody.items[0];
  assert.ok(typeof first.model === 'string' || first.model === null);
  assert.ok('skillName' in first || 'skill' in first);
  assert.ok('skillVersion' in first);

  // 带 model 过滤：只返回匹配的
  const filteredRes = await getTraces(
    new Request(`http://localhost/api/experiments/traces?agent=${agent}&model=glm-4.7&user=${TEST_USER}`),
  );
  const filteredBody = await filteredRes.json();
  assert.ok(filteredBody.items.length >= 1);
  assert.equal(filteredBody.items.every((i: { model?: string }) => i.model === 'glm-4.7'), true);
});

test('Agent、Skill、评估器对比执行并可进入原 Case 评估器详情', async (t) => {
 const agent='expanded-'+Date.now();
 const taskInputs=['检查申请','核对补充材料'];
 setJudgeLlmCallerForTest(async()=>JSON.stringify({score:80,points:[],evidence:{md:'controlled evaluator result'}}));
 t.after(()=>setJudgeLlmCallerForTest(null));
 const inputs=[{agentName:agent,model:'same',skill:'review',skillVersion:1},{agentName:agent+'-b',model:'same',skill:'review',skillVersion:1},{agentName:agent,model:'same',skill:'review',skillVersion:2}];
 for(const data of inputs) for(const query of taskInputs) await prisma.execution.create({data:{...data,user:TEST_USER,query,taskId:agent+JSON.stringify(data)+query}});
 t.after(()=>prisma.execution.deleteMany({where:{user:TEST_USER,agentName:{startsWith:agent}}}));
 await writeUserCustomEvaluators(TEST_USER,[
  {id:CUSTOM_LLM_ID,name:'A 标准',evaluatorType:'LLM',source:'custom',status:'ready',category:'res',llmConfig:{model:'test',systemPrompt:'评估 {{output}}',userPrompt:''}},
  {id:CUSTOM_LLM_ID+'-b',name:'B 标准',evaluatorType:'LLM',source:'custom',status:'ready',category:'res',llmConfig:{model:'test',systemPrompt:'评估 {{output}}',userPrompt:''}},
 ]);
 for(const [type,a,b] of [['agent',agent,agent+'-b'],['skill','review@v1','review@v2'],['evaluator',CUSTOM_LLM_ID,CUSTOM_LLM_ID+'-b']]) {
  const groups=[{key:'A',value:a},{key:'B',value:b}];
  const preview=await createExperiment(postReq('http://localhost/api/experiments',{action:'preview-comparison',user:TEST_USER,agentName:agent,type,groups}));
  const candidates=await preview.json();assert.equal(candidates.items.length,taskInputs.length);
  const response=await createExperiment(postReq('http://localhost/api/experiments',{user:TEST_USER,name:type,agentName:agent,type,groups,evaluatorIds:type==='evaluator'?[a,b]:[CUSTOM_LLM_ID]}));
  const created=await response.json();assert.equal(response.status,200,JSON.stringify(created));
  const run=await runExperiment(postReq('http://localhost/api/experiments/'+created.id+'/run?user='+TEST_USER,{}),{params:Promise.resolve({id:created.id})});assert.equal(run.status,200);
  for(let i=0;i<50;i++){const row=await prisma.experiment.findUnique({where:{id:created.id}});if(row.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  const detailRes=await getExperiment(new Request('http://localhost/api/experiments/'+created.id+'?user='+TEST_USER),{params:Promise.resolve({id:created.id})});
  const detail=await detailRes.json();assert.equal(detail.type,type);assert.equal(detail.groups.length,2);
  const c=await prisma.experimentCase.findFirst({where:{experimentId:created.id}});
  const caseRes=await getExperiment(new Request('http://localhost/api/experiments/'+created.id+'?user='+TEST_USER+'&caseId='+c.id),{params:Promise.resolve({id:created.id})});
  const caseDetail=await caseRes.json();assert.equal(caseDetail.cases?.length,1);assert.equal(caseDetail.results?.length,1);
  if(type==='evaluator'){
   const stored=await prisma.experiment.findUnique({where:{id:created.id},include:{groups:{include:{cases:{include:{results:true}}}}}});
   assert.equal(stored.status,'done');assert.equal(stored.groups.length,2);
   for(const group of stored.groups){
    const expectedEvaluator=group.key==='A'?a:b;
    assert.equal(group.cases.length,taskInputs.length);
    for(const row of group.cases){
     assert.deepEqual(row.results.map((result:any)=>result.evaluatorId),[expectedEvaluator],`${group.key}/${row.input} must use only its own evaluator`);
     assert.equal(row.results[0].status,'done');assert.equal(row.results[0].score,80);
    }
   }
   assert.equal(detail.pairing.items.length,taskInputs.length);
   const storedCases=new Map(stored.groups.flatMap((group:any)=>group.cases.map((row:any)=>[row.id,{...row,groupKey:group.key}])));
   for(const pair of detail.pairing.items){
    assert.ok(pair.a?.caseId);assert.ok(pair.b?.caseId);assert.ok(pair.a.executionId);
    assert.equal(pair.a.executionId,pair.b.executionId,`${pair.taskInput} must share the same Trace`);
    const left:any=storedCases.get(pair.a.caseId),right:any=storedCases.get(pair.b.caseId);
    assert.equal(left.groupKey,'A');assert.equal(right.groupKey,'B');
    assert.equal(left.input,pair.taskInput);assert.equal(right.input,pair.taskInput);
    assert.equal(left.executionId,right.executionId);assert.equal(left.executionId,pair.a.executionId);
   }
  }
 }
});


test('对比实验不能经通用 Case 入口单侧追加或改写共享参考答案', async (t) => {
  const agent = 'shared-case-api-' + Date.now();
  const ids: string[] = [];
  for (const model of ['a', 'b']) {
    const trace = await prisma.execution.create({ data: { user: TEST_USER, agentName: agent, model, query: 'q', taskId: agent + '-' + model } });
    ids.push(trace.id);
  }
  t.after(() => prisma.execution.deleteMany({ where: { id: { in: ids } } }));
  const createdResponse = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: 'shared-case', agentName: agent, type: 'llm', groups: [{ key: 'A', value: 'a' }, { key: 'B', value: 'b' }], evaluatorIds: [CUSTOM_LLM_ID], cases: [{ input: 'q', referenceOutput: '共享答案' }],
  }));
  assert.equal(createdResponse.status, 200);
  const { id } = await createdResponse.json();
  const original = await prisma.experimentCase.findMany({ where: { experimentId: id }, orderBy: { id: 'asc' } });
  const response = await addExperimentCases(postReq('http://localhost/api/experiments/' + id + '/cases', {
    user: TEST_USER, autoRun: false, cases: [{ executionId: ids[0], taskId: agent + '-a', input: '单侧新输入', referenceOutput: '单侧新答案' }],
  }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /共享|对比/);
  const current = await prisma.experimentCase.findMany({ where: { experimentId: id }, orderBy: { id: 'asc' } });
  assert.deepEqual(current, original);
});

test('增量重扫不能绕过版本化实验冻结，并且必须验证实验归属', async (t) => {
  const experiment = await prisma.experiment.create({ data: { user: TEST_USER, name: 'frozen-rescan', agentName: 'unused', type: 'agent', scope: 'evaluation-harness', status: 'done', groups: { create: [{ key: 'A', variableValue: 'a' }, { key: 'B', variableValue: 'b' }] } } });
  t.after(() => prisma.experiment.delete({ where: { id: experiment.id } }));
  const call = (user: string) => rescanExperiment(postReq('http://localhost/api/experiments/' + experiment.id + '/rescan', { user }), { params: Promise.resolve({ id: experiment.id }) });
  assert.equal((await call(TEST_USER + '-other')).status, 404);
  const response = await call(TEST_USER);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /历史|版本化/);
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: experiment.id } }), 0);
  assert.equal((await prisma.experiment.findUnique({ where: { id: experiment.id } }))?.status, 'done');
});
