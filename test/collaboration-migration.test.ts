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
    const schemaWithoutCollaboration = schema
        .replace(/^model Collaboration(?:Event|SessionBinding|EndpointResolution)?\s*\{[\s\S]*?^\}\s*$/gm, '')
        .replace(/^\s*collaborationEndpointResolutions\s+CollaborationEndpointResolution\[\]\s*$/m, '');
    const oldSchema = `${schemaWithoutCollaboration}
model Collaboration {
  id String @id
  user String
  collaborationId String
  createdAt String
  @@unique([user, collaborationId])
}

model CollaborationEvent {
  id String @id
  user String
  collaborationId String
  eventId String
  bodyJson String
  bodyHash String
  receivedAt String
  @@unique([user, collaborationId, eventId])
}

model CollaborationSessionBinding {
  id String @id
  user String
  collaborationId String
  sessionId String
  traceSessionId String
  eventClock String
  createdAt String
  @@unique([user, collaborationId, sessionId])
}
`;
    const schemaPath = path.join(root, 'prisma/schema.prisma');
    const url = `file:${path.join(root, 'migration.db')}`;
    const sync = async () => {
        try {
            return await execute('sh', ['scripts/db_push.sh'], { cwd: root, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, timeout: 30000 });
        } catch (error) {
            const details = error as Error & { stdout?: string; stderr?: string };
            throw new Error([details.message, details.stdout, details.stderr].filter(Boolean).join('\n'));
        }
    };
    await writeFile(schemaPath, oldSchema);
    await sync();
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        await client.session.create({ data: { taskId: 'preserve-session', user: 'migration-user', interactions: '[{"role":"assistant","content":"keep"}]' } });
        await client.execution.create({ data: { id: 'preserve-execution', taskId: 'preserve-session', user: 'migration-user', parentExecutionId: 'preserve-parent' } });
        await client.$executeRawUnsafe('INSERT INTO "Collaboration" ("id","user","collaborationId","createdAt") VALUES (?,?,?,?)', 'entry', 'migration-user', 'preserve-collaboration', new Date().toISOString());
        await client.$executeRawUnsafe('INSERT INTO "CollaborationEvent" ("id","user","collaborationId","eventId","bodyJson","bodyHash","receivedAt") VALUES (?,?,?,?,?,?,?)', 'event', 'migration-user', 'preserve-collaboration', 'event-1', '{"collaborationId":"preserve-collaboration","description":"keep","eventId":"event-1","fromSessionId":"A","toSessionId":"B"}', 'legacy-hash', new Date().toISOString());
        await client.$executeRawUnsafe('INSERT INTO "CollaborationSessionBinding" ("id","user","collaborationId","sessionId","traceSessionId","eventClock","createdAt") VALUES (?,?,?,?,?,?,?)', 'binding', 'migration-user', 'preserve-collaboration', 'A', 'preserve-session', 'source_session', new Date().toISOString());
        const before = await client.session.findUnique({ where: { taskId: 'preserve-session' } });
        await writeFile(schemaPath, schema);
        await sync();
        const tables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Collaboration%'");
        assert.deepEqual(tables.map(t => t.name).sort(), ['Collaboration', 'CollaborationEndpointResolution', 'CollaborationEvent', 'CollaborationSessionBinding']);
        await sync();
        assert.deepEqual(await client.session.findUnique({ where: { taskId: 'preserve-session' } }), before);
        assert.equal((await client.execution.findUnique({ where: { id: 'preserve-execution' } }))?.parentExecutionId, 'preserve-parent');
        const entries = await client.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "Collaboration"');
        assert.equal(entries.length, 1);
        const events = await client.$queryRawUnsafe<Array<{ bodyJson: string; collaborationDbId: string | null }>>('SELECT "bodyJson","collaborationDbId" FROM "CollaborationEvent"');
        assert.equal(events.length, 1);
        assert.match(events[0].bodyJson, /preserve-collaboration/);
        assert.equal(events[0].collaborationDbId, null);
        const bindings = await client.$queryRawUnsafe<Array<{ traceSessionId: string }>>('SELECT "traceSessionId" FROM "CollaborationSessionBinding"');
        assert.deepEqual(bindings, [{ traceSessionId: 'preserve-session' }]);
    } finally { await client.$disconnect(); }
});
