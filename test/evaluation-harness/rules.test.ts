import test from 'node:test';
import assert from 'node:assert/strict';
import { caseSchema, hash, redact } from '../../src/lib/evaluation-harness/domain';
import { evaluateRules, summarize } from '../../src/lib/evaluation-harness/rules';
const c = caseSchema.parse({
  id: 'c',
  name: '审批',
  turns: [{
    input: '高风险',
    expectation: {
      requiredTools: [{
        name: 'review',
        arguments: {
          amount: 80000
        }
      }],
      forbiddenTools: ['approve'],
      state: 'pending',
      expectedSkill: 'loan'
    }
  }]
});
test('missing evidence never passes', async () => {
  assert.equal((await evaluateRules(c, [])).verdict, 'unknown');
});
test('wrong tool and route produce evidence bound to turn', async () => {
  const r = await evaluateRules(c, [{
    input: '高风险',
    output: 'done',
    skill: 'balance',
    state: 'approved',
    tools: [{
      name: 'approve',
      arguments: {
        amount: 80000
      }
    }]
  }]);
  assert.equal(r.verdict, 'fail');
  assert.ok(r.checks.some(x => x.name === '路由' && x.turn === 1 && x.verdict === 'fail'));
});
test('required argument conditions and state pass on real evidence', async () => {
  assert.equal((await evaluateRules(c, [{
    input: '高风险',
    output: 'done',
    skill: 'loan',
    state: 'pending',
    tools: [{
      name: 'review',
      arguments: {
        amount: 80000
      }
    }]
  }])).verdict, 'pass');
});
test('semantic expectation alone is unknown to rules', async () => {
  const item = caseSchema.parse({
    id: 's',
    name: '语义',
    turns: [{
      input: 'hi',
      expectedOutput: 'hello'
    }]
  });
  assert.equal((await evaluateRules(item, [{
    input: 'hi',
    output: 'hello',
    tools: []
  }])).verdict, 'unknown');
});
test('canonical hashes are independent of object key order', () => assert.equal(hash({
  b: 1,
  a: 2
}), hash({
  a: 2,
  b: 1
})));
test('credentials are redacted recursively', () => assert.deepEqual(redact({
  nested: {
    apiKey: 'value'
  }
}), {
  nested: {
    apiKey: '[REDACTED]'
  }
}));
test('gate cannot pass while a result is unknown', () => assert.equal(summarize([{
  case: c,
  verdict: 'unknown',
  checks: [],
  evidence: []
}], 90).gate, 'unknown'));
test('JSON field constraints cover required, range, enum and nested type', async () => {
  const c = caseSchema.parse({
    id: 'json',
    name: 'JSON',
    turns: [{
      input: 'query',
      expectation: {
        fields: [{
          path: 'data.amount',
          type: 'number',
          min: 0,
          max: 10
        }, {
          path: 'status',
          enum: ['ok']
        }, {
          path: 'items',
          type: 'array'
        }]
      }
    }]
  });
  assert.equal((await evaluateRules(c, [{
    input: 'query',
    output: JSON.stringify({
      data: {
        amount: 5
      },
      status: 'ok',
      items: []
    })
  }])).verdict, 'pass');
  assert.equal((await evaluateRules(c, [{
    input: 'query',
    output: JSON.stringify({
      data: {
        amount: 11
      },
      status: 'bad',
      items: {}
    })
  }])).verdict, 'fail');
  assert.equal((await evaluateRules(c, [{
    input: 'query',
    output: 'not json'
  }])).verdict, 'fail');
});
test('tool order respects repeated calls and missing evidence', async () => {
  const c = caseSchema.parse({
    id: 'order',
    name: 'order',
    turns: [{
      input: 'q',
      expectation: {
        toolOrder: ['read', 'write', 'read']
      }
    }]
  });
  const tool = (name: string) => ({
    name,
    arguments: {}
  });
  assert.equal((await evaluateRules(c, [{
    input: 'q',
    output: 'ok',
    tools: ['read', 'write', 'read'].map(tool)
  }])).verdict, 'pass');
  assert.equal((await evaluateRules(c, [{
    input: 'q',
    output: 'ok',
    tools: ['write', 'read'].map(tool)
  }])).verdict, 'fail');
  assert.equal((await evaluateRules(c, [{
    input: 'q',
    output: 'ok'
  }])).verdict, 'unknown');
});
test('regex pathological backtracking is bounded and unknown', async () => {
  const c = caseSchema.parse({
    id: 'regex',
    name: 'regex',
    turns: [{
      input: 'q',
      expectation: {
        pattern: '^(a+)+$'
      }
    }]
  });
  const start = Date.now();
  assert.equal((await evaluateRules(c, [{
    input: 'q',
    output: 'a'.repeat(10000) + '!'
  }])).verdict, 'unknown');
  assert.ok(Date.now() - start < 3000);
});
test('contradictory tool rules and duplicate case constraints are rejected', () => {
  assert.throws(() => caseSchema.parse({
    id: 'x',
    name: 'x',
    turns: [{
      input: 'q',
      expectation: {
        requiredTools: [{
          name: 'x'
        }],
        forbiddenTools: ['x']
      }
    }]
  }));
});
test('known critical failure blocks even when another result is unknown', () => {
  const result = {
    case: c,
    verdict: 'fail' as const,
    evidence: [],
    checks: [{
      turn: 1,
      name: 'redline',
      verdict: 'fail' as const,
      reason: 'denied',
      blocking: true
    }]
  };
  assert.equal(summarize([result, {
    case: c,
    verdict: 'unknown',
    evidence: [],
    checks: []
  }], 90).gate, 'blocked');
});
test('summary separates observed routing, tool accuracy and latency', async () => {
  const result = await evaluateRules(c, [{
    input: '高风险',
    output: 'ok',
    skill: 'loan',
    state: 'pending',
    durationMs: 120,
    tools: [{
      name: 'review',
      arguments: {
        amount: 80000
      }
    }]
  }]);
  const summary = summarize([result], 90);
  assert.equal(summary.routing.accuracy, 100);
  assert.equal(summary.tools.accuracy, 100);
  assert.equal(summary.latency.meanMs, 120);
});
test('a noncritical failure does not hide an unavailable mandatory evaluator',()=>{
 const result={case:c,verdict:'fail' as const,evidence:[],checks:[{turn:1,name:'optional rule',verdict:'fail' as const,reason:'not met',blocking:false},{turn:1,name:'model service',verdict:'unknown' as const,reason:'unavailable',blocking:true}]};
 assert.equal(summarize([result],0).gate,'unknown');
 assert.equal(summarize([result],0).score,null);
});
