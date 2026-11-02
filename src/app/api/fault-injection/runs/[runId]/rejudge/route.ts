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
import { resolveUser } from '@/lib/auth/auth'

export const dynamic = 'force-dynamic'

/** Keep old clients explicit about retirement; this endpoint never invokes a model. */
export async function POST(req: Request) {
  await resolveUser(req)
  return NextResponse.json({
    code: 'FI_JUDGE_REMOVED',
    error: 'FI 独立评判已移除；请在实验中选择评估器进行评测。',
  }, { status: 410 })
}
