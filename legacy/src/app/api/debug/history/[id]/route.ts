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
import { prisma } from '@/lib/storage/prisma';

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    console.log(`[DELETE] Attempting to delete record ${id} for user ${user}`);

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        // We include user check for security
        const deleted = await (prisma as any).debugHistory.deleteMany({
            where: { id, user }
        });

        if (deleted.count === 0) {
            console.warn(`[DELETE] Record ${id} not found in database for user ${user}`);
            return NextResponse.json({ error: 'Record not found' }, { status: 404 });
        }

        console.log(`[DELETE] Record ${id} deleted successfully from database`);
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error('Failed to delete history from DB:', err);
        return NextResponse.json({ error: 'Failed to delete record' }, { status: 500 });
    }
}
