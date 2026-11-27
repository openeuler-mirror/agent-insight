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

import { isTraceGenerationFailureRetryable } from '@/lib/engine/experiment/trace-retry-policy';

export interface GrayscaleRetryRunLike {
  status?: string;
  sessionId?: string;
  failureType?: string;
  failureCode?: string;
  evaluations?: Array<{ status?: string }>;
}

export function shouldAutoRetryGrayscaleExecution(run: GrayscaleRetryRunLike, clientExecution: boolean): boolean {
  // 客户端链路已完成自己的重试预算，外层不能再启动一轮完整执行。
  return !clientExecution && run.status === 'fail' && run.failureType === 'agent_error'
    && isTraceGenerationFailureRetryable(run.failureCode || '');
}

export type GrayscaleRetryMode = 'execution' | 'evaluation';

export function resolveGrayscaleRetryMode(run: GrayscaleRetryRunLike): GrayscaleRetryMode {
  if (!run.sessionId || run.failureType) return 'execution';
  if (run.status === 'executed' || run.status === 'fail' || run.status === 'failed') {
    return 'evaluation';
  }
  return run.evaluations?.some((item) => item.status === 'failed' || item.status === 'pending')
    ? 'evaluation'
    : 'execution';
}
