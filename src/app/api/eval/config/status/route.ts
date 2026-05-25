import { db } from '@/lib/storage/prisma';
import { normalizeConfigDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        
        if (searchParams.get('check_org') === 'true') {
            return NextResponse.json({
                org_mode: process.env.ORGANIZATION_MODE === 'true',
                org_login_redirect_url: process.env.ORG_LOGIN_REDIRECT_URL || ''
            });
        }

        const id = searchParams.get('id');
        if (!id) {
            return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
        }

        const config = await db.findConfigById(id);

        if (!config) {
            return NextResponse.json({ error: 'Config not found' }, { status: 404 });
        }

        let rootCauses = [];
        let keyActions = [];
        let routingAnchors = [];
        let extractedKeyActions = null;
        try {
            if (config.rootCauses) rootCauses = JSON.parse(config.rootCauses);
            if (config.keyActions) keyActions = JSON.parse(config.keyActions);
            if (config.routingAnchors) routingAnchors = JSON.parse(config.routingAnchors);
            if (config.extractedKeyActions) extractedKeyActions = JSON.parse(config.extractedKeyActions);
        } catch (e) {}

        return NextResponse.json({
            id: config.id,
            query: config.query ?? null,
            dataset_type: normalizeConfigDatasetType(config.datasetType),
            skill: config.skill,
            skillVersion: config.skillVersion ?? null,
            routing_intent: config.routingIntent || null,
            routing_anchors: routingAnchors,
            standard_answer: config.standardAnswer || '',
            root_causes: rootCauses,
            key_actions: keyActions,
            extractedKeyActions: extractedKeyActions,
            parse_status: config.parseStatus || 'completed'
        });
    } catch (error: any) {
        console.error('Config Status Error:', error);
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
    }
}
