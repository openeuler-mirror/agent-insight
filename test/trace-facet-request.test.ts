import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { apiFetch } from '../src/lib/client/api';
import { TRACE_FILTER_COLUMNS } from '../src/lib/filters/trace-columns';

type FacetValue = { value: string; count: number };
type FacetLoader = (user: string, column: string) => Promise<FacetValue[]>;
const helperUrl = new URL('../src/lib/client/trace-facets.ts', import.meta.url);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function sourceFile(file: string) {
    return ts.createSourceFile(file, fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findNode(ast: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
    let found: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!found && predicate(node)) found = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found, `production callback must exist in ${ast.fileName}`);
    return found;
}

function expression(ast: ts.SourceFile, node: ts.Node, scope: Record<string, unknown>): any {
    const js = ts.transpileModule(`const value = ${node.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return value;`)(...Object.values(scope));
}

function effect(ast: ts.SourceFile, marker: string, scope: Record<string, unknown>): (() => void) | undefined {
    const call = findNode(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
        && Boolean(node.arguments[0]?.getText(ast).includes(marker))) as ts.CallExpression;
    return expression(ast, call.arguments[0], scope)();
}

function variable(ast: ts.SourceFile, name: string, scope: Record<string, unknown>) {
    const node = findNode(ast, item => ts.isVariableDeclaration(item) && item.name.getText(ast) === name) as ts.VariableDeclaration;
    assert.ok(node.initializer);
    return expression(ast, node.initializer, scope);
}

const page = sourceFile('app/(main)/trace/page.tsx');
const bar = sourceFile('components/observe/TraceFilterBar.tsx');
const sidebar = sourceFile('components/observe/TraceFilterSidebar.tsx');
const BAR_COLUMNS = variable(bar, 'BAR_COLUMNS', { TRACE_FILTER_COLUMNS });
const FACETED = variable(bar, 'FACETED', {});

async function facetLoader(): Promise<FacetLoader> {
    const module = await import(helperUrl.href) as { loadTraceFacetValues: FacetLoader };
    assert.equal(typeof module.loadTraceFacetValues, 'function');
    return module.loadTraceFacetValues;
}

function transport(context: TestContext) {
    const requests: Array<{ url: URL; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => new Promise<Response>((resolve, reject) => {
        const value = input instanceof Request ? input.url : String(input);
        requests.push({ url: new URL(value, 'http://facet.test'), resolve, reject });
    }));
    return requests;
}

async function integrationScope() {
    const state = { frameworks: [] as string[], agents: [] as string[], suggestions: [] as unknown[], values: [] as FacetValue[], facet: [] as FacetValue[], loaded: false };
    const scope = {
        user: 'facet-reader', apiFetch, BAR_COLUMNS, FACETED,
        loadTraceFacetValues: fs.existsSync(helperUrl) ? await facetLoader() : undefined,
        setFrameworks: (value: string[]) => { state.frameworks = value; },
        setAgentNames: (value: string[]) => { state.agents = value; },
        setSuggestions: (value: unknown[]) => { state.suggestions = value; },
        setValues: (value: FacetValue[]) => { state.values = value; },
        setFacet: (value: FacetValue[]) => { state.facet = value; },
        setLoaded: (value: boolean) => { state.loaded = value; },
        col: TRACE_FILTER_COLUMNS.find(column => column.column === 'subagentType'), stage: 'value',
    };
    return { state, scope };
}

function resolveFacets(requests: ReturnType<typeof transport>) {
    for (const request of requests) {
        const column = request.url.searchParams.get('column');
        request.resolve(Response.json(column ? [{ value: column === 'framework' ? 'opencode' : 'general', count: 7 }] : { agents: ['worker'] }));
    }
}

test('the page framework dropdown and FilterBar suggestions share one in-flight facet request', async context => {
    const requests = transport(context);
    const { state, scope } = await integrationScope();
    effect(page, 'setFrameworks', scope);
    effect(bar, 'setSuggestions', scope);
    await flush();
    const frameworkRequests = requests.filter(request => request.url.searchParams.get('column') === 'framework');
    resolveFacets(requests);
    await flush();
    assert.deepEqual(state.frameworks, ['opencode']);
    assert.deepEqual(state.agents, ['worker']);
    assert.ok(state.suggestions.some((item: any) => item.column === 'framework' && item.value === 'opencode'));
    assert.equal(frameworkRequests.length, 1, 'the same user/framework URL must be fetched once while pending');
});

test('FilterBar effect cleanup and remount retain the shared request for active subscribers', async context => {
    const requests = transport(context);
    const { state, scope } = await integrationScope();
    effect(page, 'setFrameworks', scope);
    const cleanup = effect(bar, 'setSuggestions', scope);
    cleanup?.();
    effect(bar, 'setSuggestions', scope);
    await flush();
    const counts = ['framework', 'subagentType'].map(column => requests.filter(request => request.url.searchParams.get('column') === column).length);
    resolveFacets(requests);
    await flush();
    assert.deepEqual(state.frameworks, ['opencode']);
    assert.equal(state.suggestions.length, 2, 'the remounted subscriber receives both suggestion values');
    assert.deepEqual(counts, [1, 1], 'effect replay must reuse pending framework and subagentType requests');
});

test('FilterBar value selection and the sidebar share a pending facet response', async context => {
    const requests = transport(context);
    const { state, scope } = await integrationScope();
    const cleanup = effect(bar, 'setFacet', scope);
    effect(sidebar, 'setValues', scope);
    cleanup?.();
    await flush();
    const facetRequests = requests.filter(request => request.url.searchParams.get('column') === 'subagentType');
    resolveFacets(requests);
    await flush();
    assert.deepEqual(state.facet, [], 'an unmounted subscriber ignores the result');
    assert.deepEqual(state.values, [{ value: 'general', count: 7 }]);
    assert.equal(state.loaded, true);
    assert.equal(facetRequests.length, 1, 'closing one subscriber must not duplicate or cancel another subscriber request');
});

test('concurrent facet consumers can all read one parsed JSON result', async context => {
    const requests = transport(context);
    const load = await facetLoader();
    const pending = [load('concurrent-reader', 'framework'), load('concurrent-reader', 'framework'), load('concurrent-reader', 'framework')];
    await flush();
    for (const request of requests) request.resolve(Response.json([{ value: 'opencode', count: 3 }]));
    const results = await Promise.all(pending);
    assert.deepEqual(results, Array.from({ length: 3 }, () => [{ value: 'opencode', count: 3 }]));
    assert.equal(requests.length, 1);
});

test('facet request keys isolate users and columns and encode URL values', async context => {
    const requests = transport(context);
    const load = await facetLoader();
    const identities = [['reader & admin=1', 'framework'], ['another-reader', 'framework'], ['reader & admin=1', 'subagentType']];
    const pending = identities.map(([user, column]) => load(user, column));
    await flush();
    for (const request of requests) request.resolve(Response.json([{ value: `${request.url.searchParams.get('user')}/${request.url.searchParams.get('column')}`, count: 1 }]));
    assert.deepEqual(await Promise.all(pending), identities.map(([user, column]) => [{ value: `${user}/${column}`, count: 1 }]));
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => !request.url.searchParams.has('admin')));
});

test('settled facet requests are discarded so the next call sees new data', async context => {
    const requests = transport(context);
    const load = await facetLoader();
    const first = load('fresh-reader', 'framework');
    await flush();
    requests[0].resolve(Response.json([{ value: 'old', count: 1 }]));
    assert.deepEqual(await first, [{ value: 'old', count: 1 }]);
    const second = load('fresh-reader', 'framework');
    await flush();
    assert.equal(requests.length, 2, 'there must be no completed-result or TTL cache');
    requests[1].resolve(Response.json([{ value: 'new', count: 2 }]));
    assert.deepEqual(await second, [{ value: 'new', count: 2 }]);
});

for (const failure of ['HTTP', 'network', 'JSON'] as const) test(`${failure} facet failures reject concurrent callers and allow retry`, async context => {
    const requests = transport(context);
    const load = await facetLoader();
    const user = `retry-${failure}`;
    const outcomes = Promise.allSettled([load(user, 'framework'), load(user, 'framework')]);
    await flush();
    for (const request of requests) {
        if (failure === 'network') request.reject(new TypeError('offline'));
        else request.resolve(failure === 'HTTP' ? Response.json({ error: 'unavailable' }, { status: 503 }) : new Response('{broken-json', { headers: { 'Content-Type': 'application/json' } }));
    }
    assert.deepEqual((await outcomes).map(result => result.status), ['rejected', 'rejected']);
    assert.equal(requests.length, 1);
    const retry = load(user, 'framework');
    await flush();
    assert.equal(requests.length, 2, 'a rejected promise must leave the in-flight map');
    requests[1].resolve(Response.json([{ value: 'recovered', count: 9 }]));
    assert.deepEqual(await retry, [{ value: 'recovered', count: 9 }]);
});
