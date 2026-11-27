/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server';
import { readUserCustomEvaluators, writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
  findUnsupportedCustomEvaluatorVariables,
  isValidCustomEvaluatorName,
  type EvaluatorCard,
} from '@/lib/evaluators/custom-evaluator-model';
import { syncCustomEvaluatorRegisteredAgents, invalidateCustomEvaluatorCache } from '@/lib/engine/evaluation/custom-llm-evaluator';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';
import { normalizeEvaluatorSkillCards } from '@/lib/evaluators/evaluator-skill-service';
import { EvaluatorSkillError } from '@/lib/evaluators/evaluator-skill-store';
import { getEvaluatorExecutionCapabilities } from '@/lib/evaluators/evaluator-execution-config.server';

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
    if (searchParams.get('view') === 'execution-config') {
      return NextResponse.json({ evaluators, executionCapabilities: getEvaluatorExecutionCapabilities(evaluators as EvaluatorCard[]) });
    }
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

    const usageOn = isUsageEnabled();
    const previous = await readUserCustomEvaluators(user) as EvaluatorCard[];
    const previousCount = usageOn ? previous.length : null;
    const normalized = await normalizeEvaluatorSkillCards(user, raw as EvaluatorCard[], previous);

    await writeUserCustomEvaluators(user, normalized);
    invalidateCustomEvaluatorCache();
    await syncCustomEvaluatorRegisteredAgents(user, normalized).catch(error => {
      console.warn('[user-evaluators] agent registration failed after saving:', error instanceof Error ? error.message : String(error));
    });

    recordUsageEvent({
      user,
      featureKey: 'metrics',
      eventKey:
        previousCount !== null && raw.length < previousCount ? 'evaluator.delete' : 'evaluator.save',
    });

    return NextResponse.json({ success: true, evaluators: normalized });
  } catch (error) {
    if (error instanceof EvaluatorSkillError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('user-evaluators PUT error:', error);
    return NextResponse.json({ error: 'failed to save evaluators' }, { status: 500 });
  }
}
