import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const baseline = '789e8d04';
const files = [
    ['src/app/(main)/trace/page.tsx', '2f69c3d2d1326b6e51e03f2967446088c7566b7ed61c3747d6cc0ee7465afcf5'],
    ['src/app/login/page.tsx', 'f69d560ffacab7004921d4a33c330729bda906851585c309d14e0ffcc9388093'],
    ['src/components/shell/AppSidebar.tsx', '0bb56f83dba3f191b186dc902fe908c606054fafca887d170249ae69dbd949f1'],
    ['src/lib/auth/auth-context.tsx', '4e17f9c38074ee6cdacb2c4480f7be31f7ab1ef0fe00d180abc9b49f7afca101'],
] as const;

for (const [file, expected] of files) {
    test(`frontend entry remains byte-identical to ${baseline}: ${file}`, () => {
        const bytes = readFileSync(new URL('../' + file, import.meta.url));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${file} differs from the approved frontend baseline ${baseline}`);
    });
}

function frontendSources(directory: URL): URL[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        return entry.isDirectory() ? frontendSources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

test('product frontend has no storage-core UI, auth or runtime mode branch', () => {
    for (const root of ['src/app/(main)/', 'src/app/login/', 'src/components/', 'src/lib/auth/', 'src/lib/client/']) {
        for (const file of frontendSources(new URL('../' + root, import.meta.url))) {
            assert.doesNotMatch(readFileSync(file, 'utf8'), /StorageCoreTracePage|storage-core-trace-model|useCoreAuthHook|use-core-auth|CoreAuthProvider|CoreLoginForm|core-login-form|isStorageCoreEnabled|NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE/, file.pathname);
        }
    }
});
