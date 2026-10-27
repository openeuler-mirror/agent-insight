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

import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const executionId = searchParams.get('executionId');

        if (!executionId) {
            return NextResponse.json({ error: 'executionId is required' }, { status: 400 });
        }

        const session = await (prismaRaw as any).faultDiagnosisSession.findUnique({
            where: { executionId },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        if (!session) {
            return NextResponse.json({ session: null, messages: [] });
        }

        return NextResponse.json({
            session: {
                id: session.id,
                executionId: session.executionId,
                opencodeSessionId: session.opencodeSessionId,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
            },
            messages: session.messages.map((m: any) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
            })),
        });
    } catch (error: any) {
        console.error('Failed to fetch fault diagnosis session:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { executionId, user, opencodeSessionId } = body;

        if (!executionId) {
            return NextResponse.json({ error: 'executionId is required' }, { status: 400 });
        }

        const existing = await (prismaRaw as any).faultDiagnosisSession.findUnique({
            where: { executionId },
        });

        if (existing) {
            if (opencodeSessionId && existing.opencodeSessionId !== opencodeSessionId) {
                const updated = await (prismaRaw as any).faultDiagnosisSession.update({
                    where: { executionId },
                    data: { opencodeSessionId },
                });
                return NextResponse.json({ session: updated });
            }
            return NextResponse.json({ session: existing });
        }

        const session = await (prismaRaw as any).faultDiagnosisSession.create({
            data: {
                executionId,
                user: user || null,
                opencodeSessionId: opencodeSessionId || null,
            },
        });

        return NextResponse.json({ session });
    } catch (error: any) {
        console.error('Failed to create fault diagnosis session:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}