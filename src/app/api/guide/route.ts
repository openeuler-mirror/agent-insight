import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseAdapter } from '@/lib/storage/db-interface';

interface GuideUpdateBody {
    guideDisabled?: boolean;
    currentStep?: number;
    completedSteps?: string[];
    skippedSteps?: string[];
    lastShownAt?: string | null;
    dismissedAt?: string | null;
}

interface GuideUpdateData {
    guideDisabled?: boolean;
    currentStep?: number;
    completedSteps?: string;
    skippedSteps?: string;
    lastShownAt?: Date | null;
    dismissedAt?: Date | null;
}

export async function GET(request: NextRequest) {
    const user = request.headers.get('x-user-id');
    
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const db = getDatabaseAdapter();
        let guideState = await db.findUserGuideState(user);
        
        if (!guideState) {
            guideState = await db.upsertUserGuideState(user, {
                guideDisabled: false,
                currentStep: 0,
                completedSteps: '[]',
                skippedSteps: '[]',
            });
        }
        
        return NextResponse.json(guideState);
    } catch (error) {
        console.error('Error fetching guide state:', error);
        return NextResponse.json({ error: 'Failed to fetch guide state' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const user = request.headers.get('x-user-id');
    
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body: GuideUpdateBody = await request.json();
        const db = getDatabaseAdapter();
        
        const updateData: GuideUpdateData = {};
        
        if (body.guideDisabled !== undefined) {
            updateData.guideDisabled = body.guideDisabled;
        }
        if (body.currentStep !== undefined) {
            updateData.currentStep = body.currentStep;
        }
        if (body.completedSteps !== undefined) {
            updateData.completedSteps = JSON.stringify(body.completedSteps);
        }
        if (body.skippedSteps !== undefined) {
            updateData.skippedSteps = JSON.stringify(body.skippedSteps);
        }
        if (body.lastShownAt !== undefined) {
            updateData.lastShownAt = body.lastShownAt ? new Date(body.lastShownAt) : null;
        }
        if (body.dismissedAt !== undefined) {
            updateData.dismissedAt = body.dismissedAt ? new Date(body.dismissedAt) : null;
        }
        
        const guideState = await db.upsertUserGuideState(user, updateData);
        
        return NextResponse.json(guideState);
    } catch (error) {
        console.error('Error updating guide state:', error);
        return NextResponse.json({ error: 'Failed to update guide state' }, { status: 500 });
    }
}
