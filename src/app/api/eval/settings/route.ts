import { ModelTestValidationError } from '@/lib/shared/model-connection-test';

import { getUserSettings, saveUserSettings, maskUserSettings, getRuntimeParameterTemplates, saveRuntimeParameterTemplate } from '@/lib/storage/server-config';
import { NextResponse } from 'next/server';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user');
    if (searchParams.get('section') === 'runtime-parameters') {
        return NextResponse.json({ templates: await getRuntimeParameterTemplates(user) });
    }
    // Mask model API keys before they reach the browser — the client only needs
    // a masked value for rendering. Real keys never leave the server.
    return NextResponse.json(maskUserSettings(await getUserSettings(user)));
}

export async function POST(request: Request) {
    try {
        const { settings, user, usageSource, action, template } = await request.json();
        if (!user) return NextResponse.json({ error: 'User is required' }, { status: 400 });
        if (action === 'save-runtime-parameter-template') {
            return NextResponse.json({ template: await saveRuntimeParameterTemplate(user, template) });
        }
        await saveUserSettings(user, settings);

        // 模型注册页与联网搜索页共用本接口，且都提交完整 settings 对象，
        // 无法从内容区分；由调用方显式声明来源。缺省按模型注册计。
        if (usageSource === 'web-search') {
            recordUsageEvent({ user, featureKey: 'web-search', eventKey: 'websearch.save' });
        } else {
            recordUsageEvent({ user, featureKey: 'model-registry', eventKey: 'model.save' });
        }

        return NextResponse.json(maskUserSettings(await getUserSettings(user)));
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : '保存设置失败' }, { status: e instanceof ModelTestValidationError || e instanceof TypeError ? 400 : 500 });
    }
}
