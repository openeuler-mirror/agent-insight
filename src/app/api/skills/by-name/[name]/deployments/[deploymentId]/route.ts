import {withCoreControlRoute} from '@/lib/storage-core/control-route';
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { NextRequest, NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {withCoreExperiments,requireCoreExperimentContext} from '@/lib/storage-core/experiments'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { ReliabilityError } from '@/lib/reliability/client-registry'
import { getSkillDeployment } from '@/lib/skill-deployment/service'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ name: string; deploymentId: string }> }) {
  return withCoreControlRoute(request,async()=>{
  {
    try{return await withCoreExperiments(request,()=>statusRequest(request,context))}
    catch(error){const status=Number((error as {status?:number})?.status);return reliabilityErrorResponse(error instanceof ReliabilityError?error:new ReliabilityError('SOURCE_UNAVAILABLE','身份或存储来源不可用',[400,401,403,404,409,413,422,503].includes(status)?status:503),'skill-deployment/status')}
  }

  },["read"]);
}
async function statusRequest(request: NextRequest, context: { params: Promise<{ name: string; deploymentId: string }> }) {
  try {
    const { username } = ({username:requireCoreExperimentContext().actor.username})
    if (!username) throw new ReliabilityError('USER_REQUIRED', 'user is required', 400)
    const { name, deploymentId } = await context.params
    const deployment = await getSkillDeployment(username, decodeURIComponent(name), deploymentId)
    if (!deployment) throw new ReliabilityError('DEPLOYMENT_NOT_FOUND', '下发记录不存在', 404)
    return NextResponse.json({ deployment })
  } catch (error) {
    if(isStorageCoreEnabled()&&!(error instanceof ReliabilityError))throw error
    return reliabilityErrorResponse(error, 'skill-deployment/status')
  }
}
