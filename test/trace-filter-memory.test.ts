import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseAsString } from 'nuqs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/client/use-trace-filter-memory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(storage = new Map<string, string>(), initialQuery = '', initialUser: string | null = 'reader', unavailable = false) {
    let user = initialUser;
    let query = initialQuery;
    let state: Record<string, string | null> | undefined;
    let defaults: Record<string, string | null>;
    let dirty = false;
    let cursor = 0;
    const slots: any[] = [];
    let effects: Array<() => void> = [];
    const writes: Array<{ history: string }> = [];
    const react = {
        useRef: (value: unknown) => {
            const index = cursor++;
            return slots[index] ??= { current: value };
        },
        useState: (value: unknown) => {
            const index = cursor++;
            if (!(index in slots)) slots[index] = value;
            return [slots[index], (next: unknown) => {
                if (next !== slots[index]) { slots[index] = next; dirty = true; }
            }];
        },
        useEffect: (callback: () => void, deps: unknown[]) => {
            const index = cursor++;
            const previous = slots[index] as unknown[] | undefined;
            slots[index] = deps;
            if (!previous || deps.some((value, i) => value !== previous[i])) effects.push(callback);
        },
    };
    const setFilters = (next: Record<string, string | null>, options: { history: string }) => {
        state = { ...state, ...next };
        const params = new URLSearchParams(query);
        for (const [key, value] of Object.entries(next)) {
            if (value === null || value === defaults[key]) params.delete(key);
            else params.set(key, value);
        }
        query = params.toString();
        writes.push(options);
        dirty = true;
        return Promise.resolve(params);
    };
    const exports: any = {};
    const require = (name: string) => {
        if (name === 'react') return react;
        if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams(query) };
        if (name === 'nuqs') return {
            parseAsString,
            useQueryStates: (parsers: Record<string, { defaultValue?: string }>) => {
                defaults = Object.fromEntries(Object.entries(parsers).map(([key, p]) => [key, p.defaultValue ?? null]));
                state ??= Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, new URLSearchParams(query).get(key) ?? value]));
                return [state, setFilters];
            },
        };
        throw new Error(`Unexpected import: ${name}`);
    };
    const sessionStorage = {
        getItem: (key: string) => { if (unavailable) throw new Error('disabled'); return storage.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (unavailable) throw new Error('disabled'); storage.set(key, value); },
        removeItem: (key: string) => { if (unavailable) throw new Error('disabled'); storage.delete(key); },
    };
    new Function('require', 'exports', 'window', compiled)(require, exports, { sessionStorage });
    let result: { filtersReady: boolean; clearFilterMemory: () => void };
    const readiness: boolean[] = [];
    function render() {
        let renders = 0;
        do {
            assert.ok(renders++ < 10, 'filter hydration must settle');
            dirty = false;
            cursor = 0;
            effects = [];
            result = exports.useTraceFilterMemory(user);
            readiness.push(result.filtersReady);
            effects.forEach(effect => effect());
        } while (dirty);
    }
    render();
    return {
        storage, writes, readiness,
        filters: () => state!,
        ready: () => result.filtersReady,
        query: () => new URLSearchParams(query),
        choose: (next: Record<string, string | null>) => { setFilters(next, { history: 'replace' }); render(); },
        reset: () => { result.clearFilterMemory(); render(); },
        login: (next: string) => { user = next; render(); },
    };
}

test('leaving and revisiting bare Trace restores filters before releasing list loading', () => {
    const first = harness();
    const chosen = {
        status: 'failed', framework: 'agenterrorbench', ownership: 'system', scope: 'subagent',
        time: '7d', agent: 'worker', skill: 'diagnose', tagIds: 'release-v2,regression',
        anomaly: 'abnormal', q: 'tool timeout', f: '[{"field":"tokens","operator":"gt","value":100}]',
    };
    first.choose(chosen);
    const returned = harness(first.storage);
    assert.deepEqual(returned.filters(), first.filters());
    assert.equal(returned.readiness[0], false);
    assert.equal(returned.ready(), true);
    assert.equal(returned.query().get('status'), 'failed');
    assert.equal(returned.query().get('framework'), 'agenterrorbench');
    assert.equal(returned.writes[0].history, 'replace');
    assert.equal(returned.query().has('taskId'), false);
    assert.equal(returned.query().has('page'), false);
});

test('explicit URL context wins completely over remembered filters', () => {
    for (const query of ['status=success', 'taskId=trace-123', 'page=3']) {
        const first = harness();
        first.choose({ status: 'failed', framework: 'agenterrorbench' });
        const linked = harness(first.storage, query);
        assert.equal(linked.filters().status, query.startsWith('status=') ? 'success' : 'all');
        assert.equal(linked.filters().framework, 'all');
        assert.equal(linked.writes.length, 0, 'opening a link must not replace its query');
        assert.equal(linked.query().toString(), query);
    }
});

test('reset removes memory and old selections do not reappear on return', () => {
    const page = harness();
    page.choose({ status: 'failed', framework: 'agenterrorbench', bizTag: 'legacy-tag' });
    page.reset();
    assert.equal(page.storage.size, 0);
    assert.equal(page.filters().status, 'all');
    assert.equal(page.filters().ownership, 'all');
    assert.equal(page.filters().bizTag, null);
    const returned = harness(page.storage);
    assert.equal(returned.filters().status, 'all');
    assert.equal(returned.filters().framework, 'all');
    page.choose({ status: 'success' });
    assert.equal(harness(page.storage).filters().status, 'success', 'new selections can be remembered after reset');
});

test('memory waits for login and isolates accounts', () => {
    const first = harness();
    first.choose({ status: 'failed' });
    const other = harness(first.storage, '', 'another-reader');
    assert.equal(other.filters().status, 'all');
    const loggedOut = harness(first.storage, '', null);
    assert.equal(loggedOut.ready(), false);
    loggedOut.login('reader');
    assert.equal(loggedOut.filters().status, 'failed');
    assert.equal(loggedOut.ready(), true);
});

test('corrupt or unavailable session storage never blocks browsing or reset', () => {
    for (const raw of ['invalid json', '[]', '{"status":42}', '{"status":null}']) {
        const seeded = harness();
        const key = [...seeded.storage.keys()][0];
        seeded.storage.set(key, raw);
        const page = harness(seeded.storage);
        assert.equal(page.ready(), true);
        assert.equal(page.filters().status, 'all');
    }
    const disabled = harness(new Map(), '', 'reader', true);
    disabled.choose({ status: 'failed' });
    disabled.reset();
    assert.equal(disabled.ready(), true);
    assert.equal(disabled.filters().status, 'all');
});
