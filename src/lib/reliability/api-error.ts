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

import { NextResponse } from 'next/server'

import { ReliabilityError } from '@/lib/reliability/client-registry'

/** 统一错误响应形状（需求文档 §10.1）。 */
export function reliabilityErrorResponse(error: unknown, scope: string) {
  if (error instanceof ReliabilityError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    )
  }
  console.error(`[${scope}]`, error)
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'internal error' } },
    { status: 500 },
  )
}
