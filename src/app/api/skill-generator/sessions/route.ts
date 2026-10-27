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
        const user = searchParams.get('user');

        if (!user) {
            return NextResponse.json({ error: 'User is required' }, { status: 400 });
        }

        const sessions = await (prismaRaw as any).skillGeneratorSession.findMany({
            where: { user },
            orderBy: { updatedAt: 'desc' },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        return NextResponse.json({ sessions });
    } catch (error: any) {
        console.error('Failed to fetch sessions:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { user, title, files, messages } = body;

        if (!user) {
            return NextResponse.json({ error: 'User is required' }, { status: 400 });
        }

        const session = await (prismaRaw as any).skillGeneratorSession.create({
            data: {
                user,
                title: title || 'New Chat',
                files: files ? JSON.stringify(files) : '{}',
                messages: {
                    create: messages?.map((m: any) => ({
                        role: m.role,
                        content: m.content
                    })) || []
                }
            },
            include: {
                messages: true
            }
        });

        return NextResponse.json({ session });
    } catch (error: any) {
        console.error('Failed to create session:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
