
import { getUserSettings, saveUserSettings, maskUserSettings } from '@/lib/storage/server-config';
import { NextResponse } from 'next/server';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user');
    // Mask model API keys before they reach the browser — the client only needs
    // a masked value for rendering. Real keys never leave the server.
    return NextResponse.json(maskUserSettings(await getUserSettings(user)));
}

export async function POST(request: Request) {
    try {
        const { settings, user, usageSource } = await request.json();
        if (!user) return NextResponse.json({ error: 'User is required' }, { status: 400 });
        await saveUserSettings(user, settings);

        // 模型注册页与联网搜索页共用本接口，且都提交完整 settings 对象，
        // 无法从内容区分；由调用方显式声明来源。缺省按模型注册计。
        if (usageSource === 'web-search') {
            recordUsageEvent({ user, featureKey: 'web-search', eventKey: 'websearch.save' });
        } else {
            recordUsageEvent({ user, featureKey: 'model-registry', eventKey: 'model.save' });
        }

        return NextResponse.json(maskUserSettings(await getUserSettings(user)));
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
