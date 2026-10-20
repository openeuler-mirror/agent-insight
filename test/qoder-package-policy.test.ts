import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import AdmZip from 'adm-zip';
import { getQoderPluginPackageBuildInfo, serveQoderPluginPackage } from '../src/lib/ingest/qoder-plugin-package';

function fixture(t: TestContext) {
    const cwd = process.cwd();
    const previous = process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-package-policy-'));
    for (const dir of ['scripts', 'integrations/qoder-desktop', 'integrations/qoder-jetbrains']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ['LICENSE', ...['qoder_trace_collector.mjs', 'qoder_uploader_client.mjs', 'qoder_setup.mjs', 'qoder_token_usage_env.mjs'].map(name => 'scripts/' + name)]) fs.writeFileSync(path.join(root, file), '');
    fs.writeFileSync(path.join(root, 'integrations/qoder-jetbrains/gradle.properties'), 'pluginVersion=0.0.1');
    fs.writeFileSync(path.join(root, 'integrations/qoder-desktop/package.json'), '{"version":"0.0.1"}');
    for (const [dir, script] of [['qoder-jetbrains', 'build-plugin.mjs'], ['qoder-desktop', 'build-vsix.mjs']]) fs.writeFileSync(path.join(root, 'integrations', dir, script), 'process.exit(1)');
    process.chdir(root);
    process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = 'file:///disabled';
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    t.after(() => {
        process.chdir(cwd);
        if (previous === undefined) delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL;
        else process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
}

function legacyJetBrains() {
    const jar = new AdmZip();
    jar.addFile('META-INF/plugin.xml', Buffer.from('<idea-plugin/>'));
    jar.addFile('collector/qoder_jetbrains_uninstall.mjs', Buffer.from('process.exit(0)'));
    const zip = new AdmZip();
    zip.addFile('agent-insight/lib/plugin.jar', jar.toBuffer());
    return zip.toBuffer();
}

test('plugin downloads reject fresh cached packages containing retired uninstall components', async t => {
    fixture(t);
    for (const kind of ['jetbrains', 'desktop'] as const) {
        const info = await getQoderPluginPackageBuildInfo(kind);
        const desktop = new AdmZip();
        desktop.addFile('extension/uninstall-watcher.mjs', Buffer.from('process.exit(0)'));
        fs.mkdirSync(path.dirname(info.cachePath), { recursive: true });
        fs.writeFileSync(info.cachePath, kind === 'jetbrains' ? legacyJetBrains() : desktop.toBuffer());
        const future = new Date(info.sourceMtimeMs + 1000);
        fs.utimesSync(info.cachePath, future, future);
        assert.equal((await serveQoderPluginPackage(kind)).status, 503, kind);
    }
});

test('JetBrains remote downloads cannot reintroduce a retired uninstaller', async t => {
    fixture(t);
    const server = createServer((_req, res) => { res.end(legacyJetBrains()); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/legacy.zip`;
    assert.equal((await serveQoderPluginPackage('jetbrains')).status, 503);
    assert.equal(fs.existsSync((await getQoderPluginPackageBuildInfo('jetbrains')).cachePath), false);
});
