import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupRetiredRuns } from '../src/lib/runtime-cleanup/retired-runs';

async function fixture(run: (value: { home: string; directory: string; id: string; historical: string; fd: number }) => Promise<void>) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-retired-runs-')));
    const directory = path.join(home, 'logs');
    const id = randomUUID();
    const historical = randomUUID();
    const fd = fs.openSync(path.join(home, '.runtime-owner.lock'), 'w+');
    const original = process.env.AGENT_INSIGHT_RUNTIME_OWNER;
    try {
        fs.writeFileSync(fd, JSON.stringify({ id, scope: home }));
        process.env.AGENT_INSIGHT_RUNTIME_OWNER = JSON.stringify({ version: 1, id, scope: home, fd });
        fs.mkdirSync(path.join(directory, '.runtime-owners', historical, 'locks'), { recursive: true });
        fs.mkdirSync(path.join(directory, '.runtime-owners', id));
        fs.writeFileSync(path.join(directory, '.runtime-owners', historical, 'locks', 'previous.lock'), 'stale');
        fs.writeFileSync(path.join(directory, '.runtime-owners', id, 'current.lock'), 'active');
        await run({ home, directory, id, historical, fd });
    } finally {
        if (original === undefined) delete process.env.AGENT_INSIGHT_RUNTIME_OWNER;
        else process.env.AGENT_INSIGHT_RUNTIME_OWNER = original;
        fs.closeSync(fd);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function collect(directory: string, dryRun = false) {
    const events = [];
    for await (const event of cleanupRetiredRuns({ directory, dryRun })) events.push(event);
    return events;
}

test('reclaims retired metadata incrementally while preserving the current run and unrelated files', async () => fixture(async ({ home, directory, id, historical }) => {
    fs.writeFileSync(path.join(directory, 'states.json'), 'business state');
    fs.mkdirSync(path.join(directory, '.runtime-owners', 'unrelated'));
    const events = await collect(directory);
    assert.equal(fs.existsSync(path.join(directory, '.runtime-owners', historical)), false);
    assert.equal(fs.readFileSync(path.join(directory, '.runtime-owners', id, 'current.lock'), 'utf8'), 'active');
    assert.equal(fs.readFileSync(path.join(directory, 'states.json'), 'utf8'), 'business state');
    assert.equal(fs.existsSync(path.join(directory, '.runtime-owners', 'unrelated')), true);
    assert.equal(fs.existsSync(path.join(home, '.runtime-owner.lock')), true);
    assert.equal(events.filter(event => event.kind === 'deleted').length, 3);
    assert.ok(events.filter(event => event.kind === 'scanned').length >= 4);
}));

test('dry run scans retired metadata without deleting or rewriting any files', async () => fixture(async ({ directory, historical }) => {
    const events = await collect(directory, true);
    assert.equal(fs.readFileSync(path.join(directory, '.runtime-owners', historical, 'locks', 'previous.lock'), 'utf8'), 'stale');
    assert.equal(events.some(event => event.kind === 'deleted'), false);
    assert.equal(events.some(event => event.kind === 'scanned'), true);
}));

test('refuses cleanup without a validated runtime owner', async () => fixture(async ({ directory, historical }) => {
    delete process.env.AGENT_INSIGHT_RUNTIME_OWNER;
    await collect(directory);
    assert.equal(fs.existsSync(path.join(directory, '.runtime-owners', historical)), true);
}));

test('refuses metadata cleanup outside the exclusively owned runtime home', async () => fixture(async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-external-runs-')));
    try {
        const old = path.join(outside, '.runtime-owners', randomUUID());
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'external.lock'), 'untouched');
        await collect(outside);
        assert.equal(fs.readFileSync(path.join(old, 'external.lock'), 'utf8'), 'untouched');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('does not follow symlinks at run roots or inside retired metadata', async () => fixture(async ({ home, directory, historical }) => {
    const outside = path.join(home, 'business');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
    fs.symlinkSync(outside, path.join(directory, '.runtime-owners', randomUUID()));
    fs.symlinkSync(outside, path.join(directory, '.runtime-owners', historical, 'external'));
    await collect(directory);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched');
}));

test('stops after the cleanup root is replaced between yielded steps', async () => fixture(async ({ home, directory, historical }) => {
    const generator = cleanupRetiredRuns({ directory });
    assert.equal((await generator.next()).done, false);
    fs.renameSync(directory, path.join(home, 'original'));
    fs.mkdirSync(path.join(directory, '.runtime-owners', historical, 'locks'), { recursive: true });
    const replacement = path.join(directory, '.runtime-owners', historical, 'locks', 'previous.lock');
    fs.writeFileSync(replacement, 'replacement');
    for await (const event of generator) assert.notEqual(event.kind, 'deleted');
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement');
}));

test('stops after the runtime generation changes between yielded steps', async () => fixture(async ({ home, directory, historical, fd }) => {
    const generator = cleanupRetiredRuns({ directory });
    assert.equal((await generator.next()).done, false);
    const nextId = randomUUID();
    fs.writeSync(fd, JSON.stringify({ id: nextId, scope: home }), 0, 'utf8');
    process.env.AGENT_INSIGHT_RUNTIME_OWNER = JSON.stringify({ version: 1, id: nextId, scope: home, fd });
    for await (const event of generator) assert.notEqual(event.kind, 'deleted');
    assert.equal(fs.existsSync(path.join(directory, '.runtime-owners', historical, 'locks', 'previous.lock')), true);
}));

test('stops after the metadata root is replaced with a symlink between yielded steps', async () => fixture(async ({ home, directory, historical }) => {
    const base = path.join(directory, '.runtime-owners');
    const replacement = path.join(home, 'other-metadata');
    fs.mkdirSync(path.join(replacement, historical, 'locks'), { recursive: true });
    const protectedFile = path.join(replacement, historical, 'locks', 'previous.lock');
    fs.writeFileSync(protectedFile, 'untouched');
    const generator = cleanupRetiredRuns({ directory });
    assert.equal((await generator.next()).done, false);
    fs.renameSync(base, path.join(directory, '.old-runtime-owners'));
    fs.symlinkSync(replacement, base);
    for await (const event of generator) assert.notEqual(event.kind, 'deleted');
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'untouched');
}));

test('limits recursion depth and allows the scheduler to stop before any deletion', async () => fixture(async ({ directory, historical }) => {
    const deep = path.join(directory, '.runtime-owners', historical, ...Array.from({ length: 12 }, (_, i) => `level-${i}`));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'keep'), 'too deep');
    const generator = cleanupRetiredRuns({ directory });
    assert.equal((await generator.next()).value?.kind, 'scanned');
    await generator.return(undefined);
    assert.equal(fs.existsSync(path.join(directory, '.runtime-owners', historical, 'locks', 'previous.lock')), true);
    const events = await collect(directory);
    assert.equal(events.some(event => event.reason === 'metadata-depth-limit'), true);
    assert.equal(fs.readFileSync(path.join(deep, 'keep'), 'utf8'), 'too deep');
}));
