import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';

const execute = promisify(execFile);

test('startup db_push upgrades an existing SQLite database additively and is repeatable', { timeout: 90000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'collaboration-migration-'));
    await mkdir(path.join(root, 'prisma'));
    await mkdir(path.join(root, 'scripts'));
    await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    await writeFile(path.join(root, 'scripts/db_push.sh'), await readFile('scripts/db_push.sh'));
    const schema = (await readFile('prisma/schema.prisma', 'utf8')).replace(/generator client\s*\{[^}]*\}/, '');
    const oldSchema = schema.replace(/model Collaboration(?:Event|SessionBinding)?\s*\{[^}]*\}/g, '');
    const schemaPath = path.join(root, 'prisma/schema.prisma');
    const url = `file:${path.join(root, 'migration.db')}`;
    const sync = () => execute('sh', ['scripts/db_push.sh'], { cwd: root, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, timeout: 30000 });
    await writeFile(schemaPath, oldSchema);
    await sync();
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        await client.session.create({ data: { taskId: 'preserve-session', user: 'migration-user', interactions: '[{"role":"assistant","content":"keep"}]' } });
        await client.execution.create({ data: { id: 'preserve-execution', taskId: 'preserve-session', user: 'migration-user', parentExecutionId: 'preserve-parent' } });
        const before = await client.session.findUnique({ where: { taskId: 'preserve-session' } });
        await writeFile(schemaPath, schema);
        await sync();
        const tables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Collaboration%'");
        assert.deepEqual(tables.map(t => t.name).sort(), ['Collaboration', 'CollaborationEvent', 'CollaborationSessionBinding']);
        await client.$executeRawUnsafe('INSERT INTO "Collaboration" ("id","user","collaborationId","createdAt") VALUES (?,?,?,?)', 'entry', 'migration-user', 'preserve-collaboration', new Date().toISOString());
        await sync();
        assert.deepEqual(await client.session.findUnique({ where: { taskId: 'preserve-session' } }), before);
        assert.equal((await client.execution.findUnique({ where: { id: 'preserve-execution' } }))?.parentExecutionId, 'preserve-parent');
        const entries = await client.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "Collaboration"');
        assert.equal(entries.length, 1);
    } finally { await client.$disconnect(); }
});
