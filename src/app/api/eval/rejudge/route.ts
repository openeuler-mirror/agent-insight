import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {handleCoreOutcomeRejudge} from '@/lib/storage-core/trace-outcome';
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

import { readConfig, saveExecutionRecord, findBestMatchConfig, extractInvokedSkillsFromSessionInteractions } from '@/lib/storage/data-service';
import { analyzeFailures, InvokedSkill, judgeAnswer, normalizeInteractions } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { assertActive, finish, startOrReplace, EvaluationCancelledError } from '@/lib/evaluation-task-manager';

export async function POST(request: Request) {
  return handleCoreOutcomeRejudge(request);
}
