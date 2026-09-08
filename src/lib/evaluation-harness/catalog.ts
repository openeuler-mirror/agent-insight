import { readDemoTargets } from './adapters';
import { createAsset } from './store';
import { prisma } from '@/lib/storage/prisma';
export const demoCases = [{
  id: 'loan-low',
  name: '低风险正常审批',
  category: 'positive',
  turns: [{
    input: '申请 5 万元，风险低',
    expectation: {
      expectedSkill: 'loan_approval',
      requiredTools: [{
        name: 'approve_loan',
        arguments: {
          amount: 50000
        }
      }],
      state: 'approved'
    }
  }]
}, {
  id: 'loan-high',
  name: '高风险多轮转人工',
  category: 'negative',
  difficulty: 'hard',
  turns: [{
    input: '申请 8 万元',
    expectedOutput: '询问风险',
    expectation: {
      forbiddenTools: ['approve_loan'],
      state: 'waiting_risk'
    }
  }, {
    input: '风险高',
    expectedOutput: '转人工复核',
    expectation: {
      expectedSkill: 'loan_approval',
      requiredTools: [{
        name: 'request_human_review',
        arguments: {
          amount: 80000,
          risk: 'high'
        }
      }],
      forbiddenTools: ['approve_loan'],
      state: 'pending_review'
    }
  }]
}, {
  id: 'loan-limit',
  name: '金额超过自动审批上限',
  category: 'boundary',
  turns: [{
    input: '申请 100 万元，风险低',
    expectation: {
      requiredTools: [{
        name: 'request_human_review'
      }],
      forbiddenTools: ['approve_loan'],
      state: 'pending_review'
    }
  }]
}, {
  id: 'balance',
  name: '查询额度',
  category: 'positive',
  turns: [{
    input: '查询剩余额度',
    expectation: {
      expectedSkill: 'balance_query',
      requiredTools: [{
        name: 'query_balance'
      }],
      fields: [{
        path: 'balance',
        type: 'number',
        min: 0
      }],
      state: 'balance_returned'
    }
  }]
}];
export async function bootstrap(user: string) {
  const ensure = async (kind: any, assetKey: string, name: string, content: unknown, version = 1) => {
    if (!(await prisma.evaluationAssetVersion.findFirst({
      where: {
        user,
        kind,
        assetKey,
        version
      }
    }))) await createAsset(user, kind, assetKey, name, content);
  };
  for (const target of await readDemoTargets()) await ensure('target', target.assetKey, target.name, target.content, target.version);
  await ensure('dataset', 'loan-cases', '贷款业务验收集', {
    cases: demoCases
  });
  await ensure('evaluator', 'business-rules', '逐轮业务规则', {
    type: 'rules',
    criticalStop: true
  });
  await ensure('evaluator', 'skill-routing-rules', 'Skill 路由正确性', {type:'rules',checkNames:['路由']});
  await ensure('evaluator', 'semantic-judge', '任务语义评估', {
    type: 'llm',
    prompt: '逐轮判断实际输出是否满足预期，返回 checks 数组，每项包含 turn、verdict（pass/fail/unknown）和 reason。证据不足必须 unknown。'
  });
}
