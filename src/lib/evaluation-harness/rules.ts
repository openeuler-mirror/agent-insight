import { Worker } from 'node:worker_threads';
import { canonical, verdict, type Check, type EvalCase, type TurnEvidence, type Verdict } from './domain';
export interface CaseResult {
  case: EvalCase;
  verdict: Verdict;
  checks: Check[];
  evidence: TurnEvidence[];
}
function partial(want: unknown, got: unknown): boolean {
  if (want && typeof want === 'object' && !Array.isArray(want)) return !!got && typeof got === 'object' && Object.entries(want).every(([k, v]) => partial(v, (got as Record<string, unknown>)[k]));
  return canonical(want) === canonical(got);
}
async function regexMatch(pattern: string, text: string): Promise<boolean | null> {
  return new Promise(resolve => {
    const w = new Worker(`const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage(new RegExp(workerData[0]).test(workerData[1]));`, {
      eval: true,
      workerData: [pattern, text.slice(0, 100000)]
    });
    const timer = setTimeout(() => {
      void w.terminate();
      resolve(null);
    }, 200);
    w.once('message', v => {
      clearTimeout(timer);
      void w.terminate();
      resolve(Boolean(v));
    });
    w.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
export async function evaluateRules(c: EvalCase, evidence: TurnEvidence[]): Promise<CaseResult> {
  const checks: Check[] = [];
  for (let i = 0; i < c.turns.length; i++) {
    const turn = c.turns[i],
      e = turn.expectation,
      a = evidence[i];
    const add = (name: string, result: boolean | null, reason: string) => checks.push({
      turn: i + 1,
      name,
      verdict: result === null ? 'unknown' : result ? 'pass' : 'fail',
      reason,
      blocking: e.blocking
    });
    if (!a) {
      add('执行证据', null, '未收到该轮执行记录');
      continue;
    }
    if (e.contains !== undefined) add('文本包含', a.output.includes(e.contains), `要求包含：${e.contains}`);
    if (e.pattern) add('正则匹配', await regexMatch(e.pattern, a.output), '与配置的正则匹配；超时视为无法判断');
    if (e.expectedSkill) add('路由', a.skill ? e.expectedSkill === a.skill : null, `预期 ${e.expectedSkill}；实际 ${a.skill || '未采集'}`);
    if (e.state) add('结束状态', a.state ? e.state === a.state : null, `预期 ${e.state}；实际 ${a.state || '未采集'}`);
    for (const tool of e.requiredTools) {
      const calls = a.tools?.filter(t => t.name === tool.name);
      add('必须工具', a.tools ? !!calls?.length : null, tool.name);
      if (tool.arguments) add('工具参数', a.tools ? !!calls?.some(t => partial(tool.arguments, t.arguments)) : null, tool.name);
    }
    for (const name of e.forbiddenTools) add('禁止工具', a.tools ? !a.tools.some(t => t.name === name) : null, name);
    if (e.toolOrder.length) {
      let at = -1,
        ok = true;
      for (const name of e.toolOrder) {
        const next = a.tools?.findIndex((t, j) => j > at && t.name === name) ?? -1;
        if (next < 0) {
          ok = false;
          break;
        }
        at = next;
      }
      add('工具顺序', a.tools ? ok : null, e.toolOrder.join(' → '));
    }
    if (e.fields.length) {
      let output: unknown;
      try {
        output = JSON.parse(a.output);
      } catch {
        add('JSON 结构', false, '输出不是有效 JSON');
      }
      if (output !== undefined) for (const f of e.fields) {
        let v: unknown = output;
        for (const k of f.path.split('.')) {
          v = v && typeof v === 'object' ? Object.prototype.hasOwnProperty.call(v, k) ? (v as Record<string, unknown>)[k] : undefined : undefined;
        }
        const exists = v !== undefined;
        let ok = !f.required || exists;
        if (exists) {
          if (f.type) ok &&= f.type === 'array' ? Array.isArray(v) : f.type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === f.type;
          if (Object.prototype.hasOwnProperty.call(f, 'equals')) ok &&= canonical(v) === canonical(f.equals);
          if (f.min !== undefined) ok &&= typeof v === 'number' && v >= f.min;
          if (f.max !== undefined) ok &&= typeof v === 'number' && v <= f.max;
          if (f.enum) ok &&= f.enum.some(x => canonical(x) === canonical(v));
        }
        add('字段 ' + f.path, ok, '检查必填、类型、范围和取值');
      }
    }
    if (!checks.some(x => x.turn === i + 1)) add('规则配置', null, '本轮没有确定性检查条件；语义预期交由 LLM 评估');
  }
  return {
    case: c,
    checks,
    evidence,
    verdict: verdict(checks)
  };
}
export function summarize(results: CaseResult[], threshold: number) {
  let pass = 0,
    fail = 0,
    unknown = 0;
  const byCategory: Record<string, {
      total: number;
      pass: number;
    }> = {},
    byDifficulty: Record<string, {
      total: number;
      pass: number;
    }> = {},
    clusters: Record<string, {
      caseIds: string[];
      reason: string;
    }> = {},
    matrix: Record<string, Record<string, number>> = {};
  for (const r of results) {
    if (r.verdict === 'pass') pass++;else if (r.verdict === 'fail') fail++;else unknown++;
    for (const [group, key] of [[byCategory, r.case.category], [byDifficulty, r.case.difficulty]] as const) {
      group[key] ??= {
        total: 0,
        pass: 0
      };
      group[key].total++;
      if (r.verdict === 'pass') group[key].pass++;
    }
    for (const ch of r.checks.filter(x => x.verdict === 'fail')) {
      clusters[ch.name] ??= {
        caseIds: [],
        reason: ch.reason
      };
      if (!clusters[ch.name].caseIds.includes(r.case.id)) clusters[ch.name].caseIds.push(r.case.id);
    }
    r.case.turns.forEach((t, i) => {
      const expected = t.expectation.expectedSkill,
        actual = r.evidence[i]?.skill;
      if (expected && actual) {
        matrix[expected] ??= {};
        matrix[expected][actual] = (matrix[expected][actual] || 0) + 1;
      }
    });
  }
  const incomplete = results.filter(r=>r.verdict==='unknown' || r.checks.some(c=>c.verdict==='unknown' && !c.skipped)).length;
  const score = incomplete || !results.length ? null : 100 * pass / results.length,
    blocking = results.some(r => r.checks.some(c => c.blocking && c.verdict === 'fail'));
  const accuracy = (checks: Check[]) => {
    const known = checks.filter(x => x.verdict !== 'unknown');
    return {
      total: checks.length,
      observed: known.length,
      unknown: checks.length - known.length,
      accuracy: known.length ? 100 * known.filter(x => x.verdict === 'pass').length / known.length : null
    };
  };
  const checks = results.flatMap(r => r.checks),
    durations = results.flatMap(r => r.evidence).map(e => e.durationMs).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const byEvaluator: Record<string, {
    total: number;
    pass: number;
    fail: number;
    unknown: number;
  }> = {};
  for (const r of results) for (const id of new Set(r.checks.map(c => c.evaluatorId).filter(Boolean))) {
    const v = verdict(r.checks.filter(c => c.evaluatorId === id));
    const group = byEvaluator[id!] ??= {
      total: 0,
      pass: 0,
      fail: 0,
      unknown: 0
    };
    group.total++;
    group[v]++;
  }
  const metrics = {
    routing: accuracy(checks.filter(c => c.name === '路由')),
    tools: accuracy(checks.filter(c => ['必须工具', '禁止工具', '工具参数', '工具顺序'].includes(c.name))),
    latency: {
      turns: durations.length,
      meanMs: durations.length ? durations.reduce((s, n) => s + n, 0) / durations.length : null,
      p95Ms: durations.length ? durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] : null
    },
    byEvaluator
  };
  return {
    ...metrics,
    total: results.length,
    pass,
    fail,
    unknown,
    incomplete,
    score,
    gate: blocking ? 'blocked' : incomplete || !results.length ? 'unknown' : score! < threshold ? 'blocked' : 'pass',
    byCategory,
    byDifficulty,
    clusters,
    matrix
  };
}

export function skillTriggerAccuracy(results:CaseResult[],skill?:string){
  if(!skill)return null;
  let pass=0,fail=0,unknown=0;
  for(const result of results)result.case.turns.forEach((turn,i)=>{
    const expected=turn.expectation.expectedSkill,actual=result.evidence[i]?.skill;
    if(expected===undefined||actual===undefined){unknown++;return;}
    if((expected===skill)===(actual===skill))pass++;else fail++;
  });
  return {accuracy:pass+fail?pass/(pass+fail)*100:null,total:pass+fail+unknown,pass,fail,unknown};
}
