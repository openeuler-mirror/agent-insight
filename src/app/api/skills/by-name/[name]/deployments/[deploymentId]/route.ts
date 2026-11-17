/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { NextRequest, NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { ReliabilityError } from '@/lib/reliability/client-registry'
import { getSkillDeployment } from '@/lib/skill-deployment/service'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ name: string; deploymentId: string }> }) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'))
    if (!username) throw new ReliabilityError('USER_REQUIRED', 'user is required', 400)
    const { name, deploymentId } = await context.params
    const deployment = await getSkillDeployment(username, decodeURIComponent(name), deploymentId)
    if (!deployment) throw new ReliabilityError('DEPLOYMENT_NOT_FOUND', '下发记录不存在', 404)
    return NextResponse.json({ deployment })
  } catch (error) {
    return reliabilityErrorResponse(error, 'skill-deployment/status')
  }
}
