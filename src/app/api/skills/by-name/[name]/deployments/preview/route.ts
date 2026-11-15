/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { NextRequest, NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {withCoreExperiments,requireCoreExperimentContext} from '@/lib/storage-core/experiments'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { previewSkillDeployment, type DeploymentSource } from '@/lib/skill-deployment/service'
import { ReliabilityError } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

function sourceFromBody(body: any): DeploymentSource {
  if (body?.source?.type === 'optimization' && typeof body.source.optimizationRecordId === 'string') {
    return { type: 'optimization', optimizationRecordId: body.source.optimizationRecordId }
  }
  if (body?.source?.type === 'published_version' && Number.isInteger(body.source.skillVersion)) {
    return { type: 'published_version', skillVersion: body.source.skillVersion }
  }
  throw new ReliabilityError('DEPLOYMENT_SOURCE_INVALID', '下发来源必须是已发布优化记录或正式版本', 400)
}
export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  if(isStorageCoreEnabled()){
    try{return await withCoreExperiments(request,()=>previewRequest(request,context))}
    catch(error){const status=Number((error as {status?:number})?.status);return reliabilityErrorResponse(error instanceof ReliabilityError?error:new ReliabilityError('SOURCE_UNAVAILABLE','身份或存储来源不可用',[400,401,403,404,409,413,422,503].includes(status)?status:503),'skill-deployment/preview')}
  }
  return previewRequest(request,context)
}
async function previewRequest(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const body = await request.json().catch(() => ({}))
    const { username } = isStorageCoreEnabled()?{username:requireCoreExperimentContext().actor.username}:await resolveUser(request, body.user)
    if (!username) throw new ReliabilityError('USER_REQUIRED', 'user is required', 400)
    const { name } = await context.params
    if (body?.source?.type !== 'optimization'
      && (typeof body.sourceExecutionId !== 'string' || !body.sourceExecutionId.trim())) {
      throw new ReliabilityError('SOURCE_EXECUTION_REQUIRED', '缺少来源 Trace', 400)
    }
    const preview = await previewSkillDeployment({
      user: username,
      skillName: decodeURIComponent(name),
      sourceExecutionId: typeof body.sourceExecutionId === 'string' ? body.sourceExecutionId.trim() : '',
      source: sourceFromBody(body),
    })
    return NextResponse.json(preview)
  } catch (error) {
    if(isStorageCoreEnabled()&&!(error instanceof ReliabilityError))throw error
    return reliabilityErrorResponse(error, 'skill-deployment/preview')
  }
}
