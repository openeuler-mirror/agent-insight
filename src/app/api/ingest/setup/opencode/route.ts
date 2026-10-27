
import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

function buildPluginArtifact(source: string, apiVersion: string | null): string {
    // OpenCode 1.18.14 会把模块的每个运行时导出都当作插件工厂调用。
    const artifact = source.replace(/^export (async )?function /gm, '$1function ');
    if (apiVersion !== '2') return artifact;
    return artifact.replace('export default async function WittySkillInsightOtelPlugin', 'async function WittySkillInsightOtelPlugin')
        + '\nexport default { id: "agent-insight.trace", setup: setupOpenCodeV2 };\n';
}

export async function GET(request: Request) {
    const filePath = path.join(process.cwd(), 'scripts', 'opencode_plugin_otel.ts');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }
    const content = buildPluginArtifact(fs.readFileSync(filePath, 'utf-8'), new URL(request.url).searchParams.get('apiVersion'));
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain' }
    });
}
