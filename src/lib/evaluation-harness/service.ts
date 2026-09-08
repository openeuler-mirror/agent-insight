import { comparisonSchema, validateComparison, compareCaseVerdicts, buildDatasetPairs } from './comparison';
import { buildCheckPoints } from './result-points';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/storage/prisma';
import { caseSchema, datasetSchema, skillOverrideFor, hash, redact, verdict, type Check, type EvalCase, type Evaluator, type Target, type TurnEvidence } from './domain';
import { createAsset, getAsset } from './store';
import { executeTurn, InfrastructureError, SkillConfirmationError } from './adapters';
import { loadReplay } from './replay';
import { evaluateRules, summarize, type CaseResult } from './rules';
import { askJson, modelFor, modelIdentity } from './llm';
const runtime = globalThis as typeof globalThis & {
  evaluationHarnessActive?: Map<string, AbortController>;
};
const active = runtime.evaluationHarnessActive ??= new Map<string, AbortController>();
const manifestSchema = z.object({
  comparison: comparisonSchema.optional(),
  name: z.string().min(1).max(200),
  targetId: z.string(),
  datasetId: z.string(),
  evaluatorIds: z.array(z.string()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, '评估器不能重复'),
  threshold: z.number().min(0).max(100).default(90),
  concurrency: z.number().int().min(1).max(8).default(2),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  retries: z.number().int().min(0).max(3).default(1),
  caseIds: z.array(z.string()).min(1).max(500).refine(ids => new Set(ids).size === ids.length, 'Case ID 不能重复').optional(),
  traceSource: z.enum(['generate', 'existing']).default('generate'),
  traceAssignments: z.array(z.object({traceId:z.string().min(1),caseId:z.string().min(1)})).min(1).max(500).refine(rows=>new Set(rows.map(r=>r.traceId)).size===rows.length,'同一 Trace 不能重复选择').optional(),
  traceBindings: z.record(z.string(), z.string().min(1)).optional(),
  sourceExperimentId: z.string().optional()
});
export async function createRun(user: string, input: unknown) {
  if (process.env.DB_HOST) throw new Error('版本化多轮实验第一版需要 SQLite 存储');
  const config = manifestSchema.parse(input);
  const [target, dataset, evaluators] = await Promise.all([getAsset(user, config.targetId, 'target'), getAsset(user, config.datasetId, 'dataset'), Promise.all(config.evaluatorIds.map(id => getAsset(user, id, 'evaluator')))]);
  const comparison = config.comparison;
  const skillA = comparison?.skillAId ? await getAsset(user, comparison.skillAId, 'target') : null;
  const skillB = comparison?.skillBId ? await getAsset(user, comparison.skillBId, 'target') : null;
  const datasetB = comparison?.dimension === 'dataset' ? await getAsset(user, comparison.datasetBId!, 'dataset') : null;
  const targetB = comparison?.targetBId ? await getAsset(user, comparison.targetBId, 'target') : null;
  const evaluatorsB = comparison?.dimension === 'evaluator' ? await Promise.all((comparison.evaluatorBIds || []).map(id => getAsset(user, id, 'evaluator'))) : evaluators;
  if (comparison) {
    validateComparison(comparison, target, targetB, config.evaluatorIds, dataset, datasetB, skillA, skillB);
    if (config.traceSource === 'existing' && comparison.dimension !== 'evaluator') throw new Error('版本化目标对比请分别生成 Trace；已有 Trace 对比请使用原有 Trace 评测集');
  }
  const allEvaluators = [...new Map([...evaluators, ...evaluatorsB].map(e => [e.id,e])).values()];
  if ([target, ...(targetB ? [targetB] : []), ...(skillA ? [skillA] : []), ...(skillB ? [skillB] : []), dataset, ...(datasetB ? [datasetB] : []), ...allEvaluators].some(a => a.archived)) throw new Error('归档资产不能用于新实验，请先恢复');
  if (config.sourceExperimentId && !(await prisma.experiment.findFirst({
    where: {
      user,
      id: config.sourceExperimentId
    }
  }))) throw new Error('来源实验不存在');
  if (config.caseIds?.some(id => !dataset.content.cases.some((c: EvalCase) => c.id === id))) throw new Error('指定 Case 不在数据集版本中');
  if (comparison?.caseBIds?.some(id => !datasetB?.content.cases.some((c: EvalCase) => c.id === id))) throw new Error('B 组指定 Case 不在评测集版本中');
  const selectedCasesB: EvalCase[] = datasetB?.content.cases.filter((c: EvalCase) => !comparison?.caseBIds || comparison.caseBIds.includes(c.id)) || [];
  const assignments = config.traceSource === 'existing' ? config.traceAssignments : undefined;
  if (assignments?.some(a => !dataset.content.cases.some((c: EvalCase) => c.id === a.caseId))) throw new Error('关联 Case 不在评测集版本中');
  const selectedCases: EvalCase[] = assignments ? assignments.map(a => dataset.content.cases.find((c: EvalCase) => c.id === a.caseId)!) : dataset.content.cases.filter((c: EvalCase) => !config.caseIds || config.caseIds.includes(c.id));
  const replaySources = config.traceSource === 'existing' ? await Promise.all(selectedCases.map(async (c, index) => {
    const executionId = assignments?.[index].traceId || config.traceBindings?.[c.id];
    if (!executionId) throw new Error('请为每个待评 Case 选择已有 Trace');
    const source = await loadReplay(user, executionId, target);
    if (source.evidence.length > c.turns.length || source.evidence.some((t, i) => t.input.trim() !== c.turns[i].input.trim())) throw new Error('Trace 的逐轮输入与 Case 不一致，请重新绑定：' + c.name);
    return { caseId: c.id, ...source };
  })) : [];
  if (JSON.stringify(replaySources).length > 4000000) throw new Error('回放证据过大，请减少本次 Case 数');
  const modelRefs = await Promise.all(allEvaluators.filter(e => e.content.type === 'llm').map(async e => {
    const m = await modelFor(user, e.content.credentialId);
    return {
      evaluatorId: e.id,
      ...modelIdentity(m),
      keyType: e.content.credentialId ? 'private' : 'platform'
    };
  }));
  const groupConfigs = comparison ? ['A', 'B'].map((key, index) => {
    const base = index && targetB ? targetB : target;
    const skill = index ? skillB : skillA;
    const model = comparison.dimension === 'llm' ? (index ? comparison.modelB : comparison.modelA) : undefined;
    const groupEvaluators = index ? evaluatorsB : evaluators;
    const groupDataset = index && datasetB ? datasetB : dataset;
    const cases = index && datasetB ? selectedCasesB : selectedCases;
    return { id: randomUUID(), key, ...(skill ? {skill} : {}), target: {...base,content:{...base.content,...(model ? {model} : {})}}, evaluatorIds: groupEvaluators.map(e=>e.id), dataset:groupDataset, caseIds:cases.map(c=>c.id),
      label: skill ? `${skill.name} v${skill.version}` : comparison.dimension === 'dataset' ? `${groupDataset.name} v${groupDataset.version}` : comparison.dimension === 'evaluator' ? groupEvaluators.map(e=>`${e.name} v${e.version}`).join(' + ') : model || `${base.name} v${base.version}` };
  }) : [];
  const manifest = {
    kind: 'evaluation-harness-v1',
    ...config,
    ...(replaySources.length ? { replaySources } : {}),
    target,
    dataset,
    evaluators: allEvaluators,
    groups: groupConfigs,
    modelRefs,
    comparisonHash: hash({
      ...(comparison ? {comparison} : {}),
      ...(config.traceSource === 'existing' ? { traceSource: 'existing' } : {}),
      evaluatorIds: config.evaluatorIds.slice().sort(),
      modelRefs,
      threshold: config.threshold,
      concurrency: config.concurrency,
      timeoutSeconds: config.timeoutSeconds,
      retries: config.retries,
      caseIds: assignments ? assignments.map(a=>a.caseId).sort() : config.caseIds?.slice().sort() || 'all'
    }),
    createdAt: new Date().toISOString()
  };
  const r = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const experiment = await tx.experiment.create({data: {
      user, name: config.name, agentName: target.name, type: comparison?.dimension || 'single', status: 'draft', scope: 'evaluation-harness',
      skillName: skillA?.content.externalId || (target.content.type === 'skill' ? target.content.externalId : ''),
      evaluatorIdsJson: JSON.stringify(allEvaluators.map(e=>e.id)), sourceExperimentId: config.sourceExperimentId,
      configSnapshotJson: JSON.stringify({...manifest,hash:hash(manifest)}),
      groups: {create:groupConfigs.map(g=>({id:g.id,key:g.key,variableValue:g.label}))},
    }});
    const executionGroups = comparison && comparison.dimension !== 'evaluator' ? groupConfigs : [null];
    for (const group of executionGroups) for (const [index,c] of (group?.key === 'B' && datasetB ? selectedCasesB : selectedCases).entries()) await tx.experimentCase.create({data:{
      experimentId:experiment.id, groupId:group?.id,
      ...(assignments ? {executionId:assignments[index].traceId} : {}),
      input:c.turns[0].input, referenceOutput:c.turns.at(-1)?.expectedOutput || '', caseValuesJson:JSON.stringify(c),
    }});
    return experiment;
  });
  return r.id;
}
export async function runDetail(user: string, id: string) {
  const r = await prisma.experiment.findFirst({
    where: {
      user,
      id,
      scope: 'evaluation-harness'
    },
    include: {
      cases: {
        include: {
          results: true,
          traceAttempts: true
        }
      }
    }
  });
  if (!r) throw new Error('实验不存在或无权访问');
  const manifest = JSON.parse(r.configSnapshotJson || '{}');
  const results: CaseResult[] = r.cases.map((c: any) => {
    const checks: Check[] = c.results.flatMap((v: any) => {
      let e;
      try {
        e = JSON.parse(v.evidenceJson || '{}');
      } catch {
        return [];
      }
      return (e.json || e).checks || [];
    });
    const evidence: TurnEvidence[] = c.results.map((x: any) => {
      try {
        const parsed = JSON.parse(x.evidenceJson || '{}');
        return (parsed.json || parsed).turns;
      } catch {
        return null;
      }
    }).find((x: any) => x?.length) || [];
    if (c.traceGenerationError || c.results.some((x: any) => x.status !== 'done') || c.results.length < manifest.evaluators.length) checks.push({
      turn: 0,
      name: '运行状态',
      verdict: 'unknown',
      reason: c.traceGenerationError || '尚未完成评估',
      blocking: true
    });
    return {
      case: caseSchema.parse(JSON.parse(c.caseValuesJson)),
      checks,
      evidence,
      verdict: verdict(checks)
    };
  });
  const comparisonResult = manifest.comparison ? (() => {
    const groupResults = manifest.groups.map((g:any) => {
      const rows = r.cases.map((row:any,i:number) => ({row,result:results[i]})).filter(({row}:any)=>manifest.comparison.dimension === 'evaluator' || row.groupId === g.id).map(({row,result}:any)=>{
        const checks = result.checks.filter((c:Check)=>c.name!=='运行状态' && (!c.evaluatorId || g.evaluatorIds.includes(c.evaluatorId)));
        const scored = row.results.filter((v:any)=>g.evaluatorIds.includes(v.evaluatorId));
        if (row.traceGenerationError || scored.length < g.evaluatorIds.length || scored.some((v:any)=>v.status!=='done')) checks.push({turn:0,name:'运行状态',verdict:'unknown',reason:row.traceGenerationError || '本组尚未完成评估',blocking:true});
        return {...result,checks,verdict:checks.some((c:Check)=>c.verdict==='unknown')?'unknown':verdict(checks),rowId:row.id,executionId:row.executionId};
      });
      return {...g, summary:summarize(rows,manifest.threshold),rows};
    });
    const [a,b] = groupResults;
    const pairs = manifest.comparison.dimension === 'dataset' ? buildDatasetPairs(a.rows,b.rows,(a.dataset || manifest.dataset).assetKey === (b.dataset || manifest.dataset).assetKey) : a.rows.map((left:any,index:number)=>{
      const right = manifest.comparison.dimension==='evaluator' ? b.rows[index] : b.rows.find((x:any)=>x.case.id===left.case.id);
      return {caseId:left.case.id,name:left.case.name,input:left.case.turns[0].input,a:left,b:right,...compareCaseVerdicts(left.verdict,right?.verdict || 'unknown',manifest.comparison.dimension)};
    });
    const comparable = pairs.filter((p:any)=>p.comparable);
    return {dimension:manifest.comparison.dimension,groups:groupResults,pairs,comparableCount:comparable.length,
      unmatchedCount:pairs.filter((p:any)=>p.matchStatus==='a-only' || p.matchStatus==='b-only').length,
      changedDefinitionCount:pairs.filter((p:any)=>p.matchStatus==='changed').length,
      changed:comparable.filter((p:any)=>p.a.verdict!==p.b.verdict).length,
      delta:comparable.length ? comparable.reduce((sum:number,p:any)=>sum+p.delta,0)/comparable.length : null};
  })() : null;
  return {
    experiment: r,
    comparison: comparisonResult,
    manifest,
    summary: {
      ...summarize(results, manifest.threshold),
      executionErrors: r.cases.filter((c: any) => c.traceGenerationError).length
    },
    results
  };
}
export async function cancelRun(user: string, id: string) {
  const r = await prisma.experiment.updateMany({
    where: {
      id,
      user,
      scope: 'evaluation-harness',
      status: {
        in: ['draft', 'running']
      }
    },
    data: {
      status: 'cancelled'
    }
  });
  if (r.count) active.get(id)?.abort();
  return !!r.count;
}
async function claimRun(user: string, id: string) {
  await runDetail(user, id);
  const claim = await prisma.experiment.updateMany({
    where: {
      id,
      user,
      status: 'draft'
    },
    data: {
      status: 'running'
    }
  });
  if (!claim.count) throw new Error('此实验已执行；重新运行请复制为新实验');
}
export async function startRun(user: string, id: string) {
  await claimRun(user, id);
  void executeClaimedRun(user, id).catch(async () => {
    await prisma.experiment.updateMany({
      where: {
        id,
        user,
        status: 'running'
      },
      data: {
        status: 'failed'
      }
    });
  });
}
export async function executeRun(user: string, id: string) {
  await claimRun(user, id);
  return executeClaimedRun(user, id);
}
async function executeClaimedRun(user: string, id: string) {
  const detail = await runDetail(user, id);
  const controller = new AbortController();
  active.set(id, controller);
  const state = await prisma.experiment.findFirst({
    where: {
      id,
      user
    },
    select: {
      status: true
    }
  });
  if (state?.status !== 'running') controller.abort();
  const heartbeat = setInterval(() => {
    void prisma.experiment.updateMany({
      where: {
        id,
        user,
        status: 'running'
      },
      data: {
        updatedAt: new Date()
      }
    }).catch(() => controller.abort());
  }, 15000);
  const {
    manifest: rootManifest
  } = detail;
  let cursor = 0;
  const worker = async () => {
    while (cursor < detail.experiment.cases.length && !controller.signal.aborted) {
      const c = detail.experiment.cases[cursor++];
      const group = rootManifest.groups?.find((g:any)=>g.id===c.groupId);
      const manifest = group ? {...rootManifest,target:group.target,dataset:group.dataset || rootManifest.dataset,skill:group.skill} : rootManifest;
      const definition = caseSchema.parse(JSON.parse(c.caseValuesJson!));
      let evidence: TurnEvidence[] = [];
      try {
        const replay = manifest.traceSource === 'existing' ? manifest.replaySources?.find((s: any) => s.caseId === definition.id && (!manifest.traceAssignments || s.executionId === c.executionId)) : null;
        if (manifest.traceSource === 'existing') {
          if (!replay || hash(replay.evidence) !== replay.evidenceHash) throw new Error('回放证据缺失或已变化');
          await loadReplay(user, replay.executionId, manifest.target);
          evidence = replay.evidence;
        } else for (let attempt = 0; attempt <= manifest.retries; attempt++) {
          evidence = [];
          const row = await prisma.experimentTraceAttempt.create({
            data: {
              experimentId: id,
              caseId: c.id,
              attemptNo: attempt + 1,
              workerId: 'http-adapter',
              platform: 'http',
              agent: manifest.target.name,
              timeoutSeconds: manifest.timeoutSeconds,
              status: 'running',
              startedAt: new Date()
            }
          });
          const timeout = AbortSignal.timeout(manifest.timeoutSeconds * 1000),
            signal = AbortSignal.any([controller.signal, timeout]);
          try {
            for (const t of definition.turns) evidence.push(await executeTurn(user, manifest.target.content as Target, t.input, evidence, signal, {
              runId: id,
              caseId: c.id,
              attemptId: row.id,
              turn: evidence.length + 1,
              ...(manifest.skill ? {skillOverrides:[skillOverrideFor(manifest.skill)]} : {})
            }));
            await prisma.experimentTraceAttempt.update({
              where: {
                id: row.id
              },
              data: {
                status: 'ready',
                finishedAt: new Date()
              }
            });
            break;
          } catch (e) {
            await prisma.experimentTraceAttempt.update({
              where: {
                id: row.id
              },
              data: {
                status: controller.signal.aborted ? 'cancelled' : 'failed',
                failureCode: timeout.aborted ? 'timeout' : e instanceof InfrastructureError ? 'infrastructure' : 'execution',
                finishedAt: new Date()
              }
            });
            if (controller.signal.aborted || attempt === manifest.retries || !(e instanceof InfrastructureError || timeout.aborted)) throw e;
          }
        }
        evidence = redact(evidence) as TurnEvidence[];
        const traceId = replay?.executionId || await saveTrace(user, manifest.target.name, definition, evidence, manifest.skill);
        await prisma.experimentCase.update({
          where: {
            id: c.id
          },
          data: {
            executionId: traceId,
            taskId: replay?.taskId || traceId,
            actualOutput: evidence.at(-1)?.output || '',
            traceGenerationError: null
          }
        });
        await prisma.experimentTraceAttempt.updateMany({
          where: {
            caseId: c.id,
            status: 'ready'
          },
          data: {
            traceId
          }
        });
        let stop = false;
        const sorted = [...manifest.evaluators].sort((a, b) => Number(a.content.type === 'llm') - Number(b.content.type === 'llm'));
        for (const evaluator of sorted) {
          if (controller.signal.aborted) break;
          const e = evaluator.content as Evaluator;
          let checks: Check[] = [],
            score: number | null = null,
            status = 'done',
            errorMessage: string | null = null;
          try {
            if (e.type === 'rules') {
              checks = (await evaluateRules(definition, evidence)).checks.filter(check=>!e.checkNames || e.checkNames.includes(check.name as any) || (e.checkNames.includes('字段校验') && check.name.startsWith('字段 ')) || check.name==='执行证据');
              stop ||= manifest.comparison?.dimension !== 'evaluator' && e.criticalStop && checks.some(x => x.blocking && x.verdict === 'fail');
            } else if (stop) {
              checks = [{
                turn: 0,
                name: 'LLM 评估',
                skipped: true,
                verdict: 'unknown',
                reason: '关键规则失败，按配置跳过后续模型评估',
                blocking: false
              }];
            } else {
              const response = await askJson(user, e.prompt + '\n逐轮独立判定。只返回 {checks:[{turn:1,verdict:"pass"|"fail"|"unknown",reason:string}]}，每一轮恰好一项，不输出自由评分。证据不足必须 unknown。', {
                case: definition,
                evidence
              }, e.credentialId, controller.signal, manifest.modelRefs.find((r: any) => r.evaluatorId === evaluator.id)?.connectionHash);
              const judged = z.object({
                checks: z.array(z.object({
                  turn: z.number().int().min(1),
                  verdict: z.enum(['pass', 'fail', 'unknown']),
                  reason: z.string().max(4000)
                }))
              }).parse(response);
              if (judged.checks.length !== definition.turns.length || new Set(judged.checks.map(c => c.turn)).size !== definition.turns.length || judged.checks.some(c => c.turn > definition.turns.length)) throw new Error('LLM 逐轮结果不完整');
              checks = judged.checks.map(c => ({
                ...c,
                name: 'LLM 语义',
                reason: String(redact(c.reason)),
                blocking: true
              }));
              score = checks.some(c => c.verdict === 'unknown') ? null : 100 * checks.filter(c => c.verdict === 'pass').length / checks.length;
            }
          } catch {
            status = 'failed';
            errorMessage = '评估器执行失败，请检查模型连接或输出格式';
            checks = [{
              turn: 0,
              name: '评估器服务',
              verdict: 'unknown',
              reason: errorMessage,
              blocking: true
            }];
          }
          if (replay && !replay.versionVerified) {
            checks.push({ turn: 0, name: '目标版本证据', verdict: 'unknown', reason: '该 Trace 未记录可核对的 Agent 版本，不能确认版本归属', blocking: true });
            score = null;
          }
          checks = checks.map(check => ({
            ...check,
            evaluatorId: evaluator.id
          }));
          const v = verdict(checks);
          if (score === null && v !== 'unknown') score = v === 'pass' ? 100 : 0;
          await prisma.experimentEvalResult.create({
            data: {
              experimentId: id,
              caseId: c.id,
              evaluatorId: evaluator.id,
              status,
              score,
              verdict: v === 'unknown' ? 'warn' : v,
              summary: v === 'unknown' ? '无法判断' : v === 'pass' ? '通过' : '未通过',
              errorMessage,
              evidenceJson: JSON.stringify({
                json: {
                  checks,
                  turns: evidence,
                  traceId
                }
              }),
              pointsJson: JSON.stringify(buildCheckPoints(checks, evidence, definition))
            }
          });
        }
      } catch (error) {
        await prisma.experimentCase.update({
          where: {
            id: c.id
          },
          data: {
            traceGenerationError: controller.signal.aborted ? '用户终止执行' : error instanceof SkillConfirmationError ? error.message : '目标执行失败或超时；未生成有效评估结果'
          }
        });
      }
    }
  };
  try {
    await Promise.all(Array.from({
      length: rootManifest.concurrency
    }, worker));
    await prisma.experiment.updateMany({
      where: {
        id,
        user,
        status: 'running'
      },
      data: {
        status: controller.signal.aborted ? 'cancelled' : (await prisma.experimentCase.count({
          where: {
            experimentId: id,
            traceGenerationError: {
              not: null
            }
          }
        })) ? 'failed' : 'done'
      }
    });
  } catch {
    await prisma.experiment.updateMany({
      where: {
        id,
        user,
        status: 'running'
      },
      data: {
        status: 'failed'
      }
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(id);
  }
  const finished = await runDetail(user, id);
  await prisma.evaluationAnalysis.create({
    data: {
      user,
      targetId: id,
      reportJson: JSON.stringify({
        kind: 'run',
        summary: finished.summary
      })
    }
  });
  return finished;
}
async function saveTrace(user: string, agentName: string, c: EvalCase, turns: TurnEvidence[], selectedSkill?: {version:number;content:Target}) {
  const id = randomUUID();
  const startTime = turns[0]?.startedAt ? new Date(turns[0].startedAt) : new Date();
  const endTime = turns.at(-1)?.finishedAt ? new Date(turns.at(-1)!.finishedAt!) : new Date();
  const interactions = turns.flatMap((t, i) => [...(t.systemPrompt ? [{
    id: `${id}-s${i}`,
    type: 'system',
    role: 'system',
    content: t.systemPrompt,
    timestamp: t.startedAt || startTime.toISOString()
  }] : []), {
    id: `${id}-u${i}`,
    type: 'user',
    role: 'user',
    content: t.input,
    timestamp: t.startedAt || startTime.toISOString()
  }, {
    id: `${id}-a${i}`,
    type: 'assistant',
    role: 'assistant',
    content: t.output,
    metadata: { evaluation: { ...(t.loadedSkills ? {loadedSkills:t.loadedSkills} : {}), ...(t.skill ? { skill: t.skill } : {}), ...(t.state ? { state: t.state } : {}) } },
    timestamp: t.finishedAt || endTime.toISOString(),
    tool_calls: t.tools?.map((x, j) => ({
      id: `${id}-${i}-${j}`,
      type: 'function',
      function: {
        name: x.name,
        arguments: JSON.stringify(x.arguments)
      }
    }))
  }, ...(t.tools || []).map((x, j) => ({
    id: `${id}-result-${i}-${j}`,
    type: 'tool',
    role: 'tool',
    tool_call_id: `${id}-${i}-${j}`,
    name: x.name,
    content: JSON.stringify(x.result ?? null),
    timestamp: t.finishedAt || endTime.toISOString()
  }))]).map(interaction => ({
    ...interaction,
    agent: agentName
  }));
  await prisma.$transaction([prisma.session.create({
    data: {
      id,
      taskId: id,
      user,
      label: agentName,
      query: c.turns[0].input,
      startTime,
      endTime,
      interactions: JSON.stringify(interactions)
    }
  }), prisma.execution.create({
    data: {
      id,
      taskId: id,
      agentSessionId: id,
      user,
      agentName,
      framework: 'evaluation-harness',
      query: c.turns[0].input,
      finalResult: turns.at(-1)?.output,
      model: turns.find(t=>t.model)?.model,
      ...(selectedSkill ? {skill:selectedSkill.content.externalId,skillVersion:selectedSkill.version} : {}),
      skills: JSON.stringify([...new Set(turns.map(t => t.skill).filter(Boolean))]),
      latency: turns.reduce((s, t) => s + (t.durationMs || 0), 0),
      toolCallCount: turns.reduce((s, t) => s + (t.tools?.length || 0), 0)
    } satisfies Prisma.ExecutionUncheckedCreateInput
  })]);
  return id;
}
export async function generateDataset(user: string, targetId: string, credentialId?: string) {
  const target = await getAsset(user, targetId, 'target');
  const output = await askJson(user, '根据目标的实际定义生成 4 至 8 个 Case，包含 positive/negative/boundary、难度和至少一个多轮。输出 {cases:[{id,name,category,difficulty,tags,note,turns:[{input,expectedOutput,expectation:{contains?,expectedSkill?,state?,requiredTools:[{name,arguments?}],forbiddenTools:[],toolOrder:[],fields:[],blocking:true}}]}]}。不要把预期当成实际结果。', target.content, credentialId);
  return datasetSchema.parse(output);
}
export async function staticAnalysis(user: string, targetId: string) {
  const target = await getAsset(user, targetId, 'target'),
    t = target.content as Target;
  const findings: Array<{
    type: string;
    skills: string[];
    reason: string;
  }> = [];
  if (!t.skills.length) findings.push({
    type: 'Skill 定义缺失',
    skills: [],
    reason: '未提供 Skill 定义，无法检查职责边界；Trace 未采集的内容需要人工补充'
  });
  if (t.type === 'agent' && !/兜底|范围|拒绝|fallback|out.of.scope/i.test(t.prompt)) findings.push({
    type: '兜底说明缺失',
    skills: [],
    reason: '提示词未发现兜底或范围外处理说明，请人工确认'
  });
  for (const skill of t.skills) {
    if (skill.description.length < 12) findings.push({
      type: '描述不完整',
      skills: [skill.name],
      reason: '描述过短，建议补充适用条件、输入和排除范围'
    });
    if (!t.prompt.includes(skill.name)) findings.push({
      type: 'Prompt 对齐风险',
      skills: [skill.name],
      reason: 'Agent 提示词未显式提到该 Skill；请人工确认路由约定'
    });
  }
  for (let i = 0; i < t.skills.length; i++) for (let j = i + 1; j < t.skills.length; j++) {
    const a = t.skills[i],
      b = t.skills[j],
      tokens = (x: string) => new Set(x.match(/[\u4e00-\u9fff]|[a-zA-Z_]{2,}/g) || []),
      at = tokens(a.description),
      bt = tokens(b.description),
      overlap = [...at].filter(x => bt.has(x)).length / Math.max(1, new Set([...at, ...bt]).size);
    if (overlap > .55) findings.push({
      type: '描述重叠风险',
      skills: [a.name, b.name],
      reason: `文字特征重叠 ${(overlap * 100).toFixed(0)}%，需审阅职责边界`
    });
  }
  const report = {
    kind: 'static',
    method: 'deterministic-description-analysis',
    targetId,
    findings,
    note: '静态启发式风险，不是实际路由混淆或执行失败。'
  };
  return prisma.evaluationAnalysis.create({
    data: {
      user,
      targetId,
      reportJson: JSON.stringify(report)
    }
  });
}
export async function reviseDataset(user: string, experimentId: string, caseId: string, updated: unknown) {
  const detail = await runDetail(user, experimentId);
  const exactRow = detail.experiment.cases.find((row:any)=>row.id === caseId);
  const rows = exactRow ? [exactRow] : detail.experiment.cases.filter((row:any)=>JSON.parse(row.caseValuesJson || '{}').id === caseId);
  const sources = rows.map((row:any)=>detail.manifest.groups?.find((group:any)=>group.id === row.groupId)?.dataset || detail.manifest.dataset);
  if (detail.manifest.comparison?.dimension === 'dataset' && (!rows.length || new Set(sources.map((source:any)=>source.id)).size > 1)) throw new Error('请使用明确的实验 Case 行 ID 选择需要修改的评测集版本');
  const source = sources[0] || detail.manifest.dataset;
  const definitionId = exactRow ? JSON.parse(exactRow.caseValuesJson || '{}').id : caseId;
  const replacement = caseSchema.parse(updated);
  const cases = source.content.cases as EvalCase[];
  if (!cases.some(c => c.id === definitionId) || replacement.id !== definitionId) throw new Error('Case 不存在或 ID 不一致');
  return createAsset(user, 'dataset', source.assetKey, source.name, {
    cases: cases.map(c => c.id === definitionId ? replacement : c)
  });
}
export async function recoverInterruptedRuns(user: string) {
  const stale = await prisma.experiment.findMany({
    where: {
      user,
      scope: 'evaluation-harness',
      status: 'running',
      updatedAt: {
        lt: new Date(Date.now() - 120000)
      }
    },
    select: {
      id: true
    }
  });
  for (const row of stale) {
    if (active.has(row.id)) continue;
    await prisma.experiment.updateMany({
      where: {
        id: row.id,
        user,
        status: 'running',
        updatedAt: {
          lt: new Date(Date.now() - 120000)
        }
      },
      data: {
        status: 'failed'
      }
    });
    await prisma.experimentTraceAttempt.updateMany({
      where: {
        experimentId: row.id,
        status: 'running'
      },
      data: {
        status: 'failed',
        failureCode: 'interrupted',
        finishedAt: new Date()
      }
    });
  }
}
