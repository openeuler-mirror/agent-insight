/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { NextRequest, NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { ReliabilityError } from '@/lib/reliability/client-registry'
import { createSkillDeployment, type DeploymentSource } from '@/lib/skill-deployment/service'

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
  try {
    const body = await request.json().catch(() => ({}))
    const { username } = await resolveUser(request, body.user)
    if (!username) throw new ReliabilityError('USER_REQUIRED', 'user is required', 400)
    const { name } = await context.params
    const deployment = await createSkillDeployment({
      user: username,
      skillName: decodeURIComponent(name),
      sourceExecutionId: String(body.sourceExecutionId || ''),
      source: sourceFromBody(body),
      confirmed: body.confirmed === true,
      idempotencyKey: String(body.idempotencyKey || ''),
    })
    return NextResponse.json({ deployment }, { status: deployment.createdAt.getTime() === deployment.updatedAt.getTime() ? 201 : 200 })
  } catch (error) {
    return reliabilityErrorResponse(error, 'skill-deployment/create')
  }
}
