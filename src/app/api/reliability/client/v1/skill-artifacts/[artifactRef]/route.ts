/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { NextResponse } from 'next/server'

import { authenticateDevice } from '@/lib/reliability/client-registry'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { claimSkillArtifact } from '@/lib/skill-deployment/service'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ artifactRef: string }> }) {
  try {
    const { clientId } = await authenticateDevice(request)
    const { artifactRef } = await context.params
    return NextResponse.json(await claimSkillArtifact(clientId, artifactRef), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) {
    return reliabilityErrorResponse(error, 'skill-deployment/artifact')
  }
}
