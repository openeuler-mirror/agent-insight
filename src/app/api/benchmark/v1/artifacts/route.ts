import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {coreBenchmarkCallbackContext,coreBenchmarkCallbackArtifact} from '@/lib/benchmark/core-public-callback'
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

import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { storeBenchmarkArtifact } from '@/lib/benchmark/run-callback-service'
import { authenticateDevice, ReliabilityError } from '@/lib/reliability/client-registry'
import { BenchmarkProtocolError } from '../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    let identity
    try {
      identity = await authenticateDevice(req)
    } catch (error) {
      if (error instanceof ReliabilityError) {
        throw new BenchmarkProtocolError(error.code, error.message, error.status)
      }
      throw error
    }
    return NextResponse.json(await coreBenchmarkCallbackArtifact(req,coreBenchmarkCallbackContext(req,identity.clientId)),{status:201})
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/artifacts')
  }
}
