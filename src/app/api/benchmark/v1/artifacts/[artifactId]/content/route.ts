import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {withCoreExperiments,requireCoreExperimentContext} from '@/lib/storage-core/experiments'
import {coreBenchmarkCallbackContext,coreBenchmarkArtifactResponse} from '@/lib/benchmark/core-public-callback'
import {benchmarkCallbackRpc} from '@/lib/benchmark/core-store'
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

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import { resolveUser } from '@/lib/auth/auth'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { benchmarkArtifactAbsolutePath } from '@/lib/benchmark/evaluation-preparation-service'
import { readBenchmarkRunArtifact } from '@/lib/benchmark/experiment-result-service'
import { prisma } from '@/lib/storage/prisma'
import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  try {
    const { artifactId } = await params
    {
      if(req.headers.has('x-agent-insight-callback-token')){
        const jobId=req.headers.get('x-agent-insight-evaluation-id')?.trim();if(!jobId)throw new BenchmarkProtocolError('EVALUATION_ID_MISSING','缺少评测Run标识',400)
        const artifact=await benchmarkCallbackRpc<{name:string;media_type:string;sha256:string;bytes_base64:string}>(coreBenchmarkCallbackContext(req),'artifact_read',{job_id:jobId,artifact_id:artifactId})
        return coreBenchmarkArtifactResponse({name:artifact.name,mediaType:artifact.media_type,sha256:artifact.sha256,bytes:Buffer.from(artifact.bytes_base64,'base64')})
      }
      return await withCoreExperiments(req,async()=>coreBenchmarkArtifactResponse(await readBenchmarkRunArtifact({artifactId,user:requireCoreExperimentContext().actor.username})))
    }
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/artifacts/content')
  }
}
