import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const session = await (prismaRaw as any).skillGeneratorSession.findUnique({
            where: { id },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        if (!session) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        return NextResponse.json({ session });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await req.json();
        const { title, files, messages } = body;

        const data: any = {};
        if (title !== undefined) data.title = title;
        if (files !== undefined) data.files = JSON.stringify(files);

        // If messages are provided, we replace the whole conversation or append?
        // For simplicity, let's say we can append or replace. 
        // But usually messages are added via the chat API.
        // Let's just handle title and files here.

        const session = await (prismaRaw as any).skillGeneratorSession.update({
            where: { id },
            data,
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        return NextResponse.json({ session });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        // 删除后拿不到归属人，先读一次；只在统计开启时才多这一次查询。
        const owner = isUsageEnabled()
            ? (await (prismaRaw as any).skillGeneratorSession.findUnique({ where: { id }, select: { user: true } }))?.user
            : null;

        await (prismaRaw as any).skillGeneratorSession.delete({
            where: { id }
        });

        recordUsageEvent({ user: owner, featureKey: 'skill-generator', eventKey: 'skill.generate.session.delete' });

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
