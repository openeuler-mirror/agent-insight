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

import { guardTraceDataset, generationErrorResponse, traceIdentity } from '@/server/trace-datasets/http';
import { GenerationError } from '@/lib/trace-datasets/contracts';
import { hash } from '@/lib/trace-datasets/sampling';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
import { NextResponse } from 'next/server';
import {
  buildAgentDatasetItemsView,
  deleteAgentDataset,
  findAgentDataset,
} from '@/server/agent_datasets_storage';
import { isBuiltinReliabilityDataset } from '@/lib/agent-dataset-builtin';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {
  decoratePublicBenchmarkDatasets,
  isReadOnlyBenchmarkDataset,
} from '@/lib/benchmark/public-dataset';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user || !id?.trim()) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    await guardTraceDataset(request, id.trim(), user);
    const dataset = await findAgentDataset(user, id.trim());
    if (!dataset) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }

    const decorated = (await decoratePublicBenchmarkDatasets(user, [dataset]))[0];
    const view = searchParams.get('view');
    if (view === 'case') {
      const caseId = (searchParams.get('caseId') || '').trim();
      if (!caseId) return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
      const datasetCase = decorated.cases.find(item => item.id === caseId);
      if (!datasetCase) return NextResponse.json({ error: 'dataset case not found' }, { status: 404 });
      return NextResponse.json(datasetCase);
    }
    return NextResponse.json(view === 'items' ? buildAgentDatasetItemsView(decorated) : decorated);
  } catch (error) {
    if (error instanceof GenerationError) return generationErrorResponse(error);
    console.error('agent-datasets [id] GET error:', error);
    return NextResponse.json({ error: 'failed to load dataset' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    const idTrim = id?.trim() || '';
    if (!user || !idTrim) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    const owner = await traceIdentity(request, false);
    if (owner === user) {
      const manager = await getTraceDatasetManager().catch(() => null);
      const job = manager && await manager.client.traceDatasetGenerationJob.findFirst({ where: { owner, datasetId: idTrim }, select: { id: true } });
      const receipt = manager && await manager.client.traceDatasetOperationReceipt.findFirst({ where: { ownerKey: hash(owner), datasetId: idTrim, kind: 'delete' }, select: { id: true } });
      if (manager && (job || receipt)) {
        const result = await manager.remove(owner, idTrim);
        return result ? NextResponse.json(result, { status: 202 }) : new Response(null, { status: 204 });
      }
    }
    if (await guardTraceDataset(request, idTrim, user)) {
      const manager = await getTraceDatasetManager();
      const result = await manager.remove(user, idTrim);
      return result ? NextResponse.json(result, { status: 202 }) : new Response(null, { status: 204 });
    }
    const existing = await findAgentDataset(user, idTrim);
    if (!existing) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }
    if (isBuiltinReliabilityDataset(existing)) {
      return NextResponse.json(
        { error: '内置可靠性评测集不可删除' },
        { status: 403 },
      );
    }
    if (existing.datasetKind === 'benchmark' || await isReadOnlyBenchmarkDataset(user, idTrim)) {
      return NextResponse.json(
        { error: 'Benchmark 数据集由系统导入并维护，不可删除' },
        { status: 403 },
      );
    }

    const removed = await deleteAgentDataset(user, idTrim);
    if (!removed) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }

    recordUsageEvent({ user, featureKey: 'dataset', eventKey: 'dataset.delete' });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GenerationError) return generationErrorResponse(error);
    console.error('agent-datasets [id] DELETE error:', error);
    return NextResponse.json({ error: 'failed to delete dataset' }, { status: 500 });
  }
}
