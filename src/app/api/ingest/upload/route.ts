import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {handleCoreCollectorUpload} from '@/lib/storage-core/collector-entry';
import {processUploadAsync} from '@/lib/ingest/upload-analysis';
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

import { saveExecutionRecord, extractInvokedSkillsFromSessionInteractions, getDefaultIngestUser, prepareUploadQuickData } from '@/lib/storage/data-service';
import { isDeletedOpencodeSessionId } from '@/lib/ingest/opencode-deleted-sessions';
import { analyzeDynamicOnly } from '@/lib/engine/observability/flow-parser';
import { analyzeFailures, analyzeSession, InvokedSkill } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { db, prisma } from '@/lib/storage/prisma';
import { normalizeEndpointUrl } from '@/lib/infra/endpoint-resolve';
import { debounceByKey } from '@/lib/ingest/upload-analysis-debouncer';
import { getUserSettings } from '@/lib/storage/server-config';
import { assertActive, finish, startOrReplace, EvaluationCancelledError } from '@/lib/evaluation-task-manager';
import { getInternalAgentTag } from '@/lib/internal-agent-tag';
import { NextResponse } from 'next/server';
import { clientIpFromRequest } from '@/lib/reliability/client-ip';
import { normalizeTraceClientMetadata } from '@/lib/reliability/trace-client';
import { authenticateDevice } from '@/lib/reliability/client-registry';
import { reliabilityErrorResponse } from '@/lib/reliability/api-error';
import { isInProgressOpencodeSnapshot } from '@/lib/ingest/opencode-snapshot';

/**
 * 这一发 opencode 上报是不是"进行中快照"——是的话只落库，不跑异步 LLM 分析。
 *
 * 判定依据必须是**本轮对话是否跑完**，不能用 CLI 是否退出：opencode 正常交互式使用时
 * CLI 会一直开着，拿 opencode_cli_completed 当门会把每一条 trace 都判成进行中，评分 /
 * 诊断 / 流程图要等用户退出 opencode 才出，属于严重倒退（曾经上线过一版，已修）。
 *
 * trace_completed_at 由 uploader 在「已产出终稿 && 会话已 idle」时写入，正是本轮结束的
 * 信号；工具死循环的心跳快照两个条件都不满足，自然落进轻通道。
 */
export async function POST(request: Request) {
  return handleCoreCollectorUpload(request);
}
