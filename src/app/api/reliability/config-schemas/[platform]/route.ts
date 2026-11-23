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
import {
  buildBuiltinConfigSchema,
  isReliabilityPlatformId,
} from '@/lib/reliability/client-config-model'

export const dynamic = 'force-dynamic'

/** IF-N10：内置只读 Schema（随产品发布，无用户态差异）。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ platform: string }> },
) {
  try {
    const { platform } = await ctx.params
    if (!isReliabilityPlatformId(platform)) {
      return NextResponse.json(
        { error: 'PLATFORM_SCHEMA_NOT_FOUND', code: 'PLATFORM_SCHEMA_NOT_FOUND' },
        { status: 404 },
      )
    }
    return NextResponse.json(buildBuiltinConfigSchema(platform))
  } catch (error) {
    console.error('[reliability/config-schemas GET]', error)
    return NextResponse.json({ error: 'Failed to load schema' }, { status: 500 })
  }
}
