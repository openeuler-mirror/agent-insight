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

import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {withCoreDatasetRoute,getCoreDatasetContext,coreDatasetFailure,coreDatasetVersionForWrite,listCoreDatasetVersions} from '@/lib/storage-core/datasets';
import {coreGenerationRequest} from '@/lib/storage-core/dataset-generation';

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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return (withCoreDatasetRoute(request, normalized => datasetGET(normalized, context)));
}
async function datasetGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user || !id?.trim()) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    const view = searchParams.get('view');
    if (getCoreDatasetContext() && view === 'versions') return NextResponse.json(await listCoreDatasetVersions(id.trim()));
    await guardTraceDataset(request, id.trim(), user);
    let dataset = await findAgentDataset(user, id.trim());
    if (!dataset) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }
    if (getCoreDatasetContext() && isBuiltinReliabilityDataset(dataset) && !searchParams.has('version')) {
      const {ensureBuiltinReliabilityDataset} = await import('@/server/builtin-example/ensure-reliability-dataset');
      await ensureBuiltinReliabilityDataset(user);
      dataset = await findAgentDataset(user, id.trim()) || dataset;
    }

    const decorated = (await decoratePublicBenchmarkDatasets(user, [dataset]))[0];
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
    if (getCoreDatasetContext()) return coreDatasetFailure(error);
    console.error('agent-datasets [id] GET error:', error);
    return NextResponse.json({ error: 'failed to load dataset' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return (withCoreDatasetRoute(request, normalized => datasetDELETE(normalized, context)));
}
async function datasetDELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    const idTrim = id?.trim() || '';
    if (!user || !idTrim) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    if (getCoreDatasetContext()) {
      const current = await findAgentDataset(user, idTrim);
      if (!current || current.generationSource === 'trace') {
        const version = current ? await coreDatasetVersionForWrite(idTrim) : undefined;
        const result = await coreGenerationRequest(request, 'remove', {datasetId:idTrim,expectedRevision:version?.revision});
        return result ? NextResponse.json(result, {status:202}) : new Response(null, {status:204});
      }
      if (isBuiltinReliabilityDataset(current) || current.datasetKind === 'benchmark') return NextResponse.json({error:'系统数据集不可删除'},{status:403});
      await deleteAgentDataset(user, idTrim);
      recordUsageEvent({ user, featureKey: 'dataset', eventKey: 'dataset.delete' });
      return NextResponse.json({success:true});
    }
    throw new Error('Storage Core dataset context required');
  } catch (error) {
    if (error instanceof GenerationError) return generationErrorResponse(error);
    if (getCoreDatasetContext()) return coreDatasetFailure(error);
    console.error('agent-datasets [id] DELETE error:', error);
    return NextResponse.json({ error: 'failed to delete dataset' }, { status: 500 });
  }
}
