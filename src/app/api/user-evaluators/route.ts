import { NextResponse } from 'next/server';
import { readUserCustomEvaluators, writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
  findUnsupportedCustomEvaluatorVariables,
  isValidCustomEvaluatorName,
  type EvaluatorCard,
} from '@/lib/evaluators/custom-evaluator-model';
import { syncCustomEvaluatorRegisteredAgents } from '@/lib/engine/evaluation/custom-llm-evaluator';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

function validateCustomEvaluators(raw: unknown[]): string | null {
  const names = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const card = item as Record<string, unknown>;
    if (card.evaluatorType !== 'LLM') continue;

    const name = String(card.name || '').trim();
    if (!isValidCustomEvaluatorName(name)) {
      return `invalid evaluator name: ${name || '(empty)'}`;
    }
    if (names.has(name)) {
      return `duplicated evaluator name: ${name}`;
    }
    names.add(name);

    const llmConfig = card.llmConfig && typeof card.llmConfig === 'object'
      ? card.llmConfig as Record<string, unknown>
      : null;
    const systemPrompt = String(llmConfig?.systemPrompt || '');
    if (!systemPrompt.trim()) {
      return `systemPrompt is required for ${name}`;
    }
    const unsupportedVars = findUnsupportedCustomEvaluatorVariables(systemPrompt);
    if (unsupportedVars.length > 0) {
      return `unsupported variables in ${name}: ${unsupportedVars.map(v => `{{${v}}}`).join(', ')}`;
    }
    const userPrompt = String(llmConfig?.userPrompt || '');
    const unsupportedUserVars = findUnsupportedCustomEvaluatorVariables(userPrompt);
    if (unsupportedUserVars.length > 0) {
      return `unsupported variables in ${name}: ${unsupportedUserVars.map(v => `{{${v}}}`).join(', ')}`;
    }
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const evaluators = await readUserCustomEvaluators(user);
    return NextResponse.json(evaluators);
  } catch (error) {
    console.error('user-evaluators GET error:', error);
    return NextResponse.json({ error: 'failed to load evaluators' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const raw = body.evaluators;
    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: 'evaluators must be an array' }, { status: 400 });
    }
    const validationError = validateCustomEvaluators(raw);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // 评估器没有独立删除接口 —— 删除表现为"保存了一份更短的列表"，用条数变化区分。
    // 这次额外读取只在统计开启时才做，关闭时保存路径的开销与接入统计前一致
    // （null 表示没读，事件反正会被 collector 丢弃）。
    const usageOn = isUsageEnabled();
    const previousCount = usageOn ? (await readUserCustomEvaluators(user)).length : null;

    await writeUserCustomEvaluators(user, raw);
    await syncCustomEvaluatorRegisteredAgents(user, raw as EvaluatorCard[]);

    recordUsageEvent({
      user,
      featureKey: 'metrics',
      eventKey:
        previousCount !== null && raw.length < previousCount ? 'evaluator.delete' : 'evaluator.save',
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('user-evaluators PUT error:', error);
    return NextResponse.json({ error: 'failed to save evaluators' }, { status: 500 });
  }
}
