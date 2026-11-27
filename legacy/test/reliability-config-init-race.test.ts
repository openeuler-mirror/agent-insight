import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {PrismaClient} from '@prisma/client';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/reliability/client-config-service.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('client-config-service.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getOrInitConfig');
assert.ok(declaration);
const compiled = ts.transpileModule(declaration.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const initializer = (client: unknown) => new Function('prisma', `${compiled}\nreturn getOrInitConfig;`)(client) as
  (user: string, clientId: string, platform: string) => Promise<{id: string; revision: number; overrideJson: string}>;

test('并发首次读取同一客户端配置复用唯一记录，后续读取不重置修订和配置', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-config-race-'));
  const url = 'file:' + path.join(root, 'test.db');
  fs.writeFileSync(path.join(root, 'test.db'), '');
  const prisma = new PrismaClient({datasources: {db: {url}}});
  t.after(async () => {await prisma.$disconnect();fs.rmSync(root, {recursive: true, force: true});});
  await prisma.$executeRawUnsafe(`CREATE TABLE ReliabilityClientConfig (
    id TEXT PRIMARY KEY, clientId TEXT NOT NULL, user TEXT NOT NULL, platform TEXT NOT NULL,
    schemaVersion TEXT NOT NULL DEFAULT '1.0', revision INTEGER NOT NULL DEFAULT 0,
    overrideJson TEXT NOT NULL DEFAULT '{}', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL, UNIQUE(clientId, platform)
  )`);
  const clientId = 'test-config-race';
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  let conflicts = 0;
  const init = initializer({reliabilityClientConfig: {
    findUnique: async (args: Parameters<typeof prisma.reliabilityClientConfig.findUnique>[0]) => {
      const row = await prisma.reliabilityClientConfig.findUnique(args);
      if (reads < 2) {
        reads++;
        if (reads === 2) release();
        await barrier;
      }
      return row;
    },
    create: async (args: Parameters<typeof prisma.reliabilityClientConfig.create>[0]) => {
      try {return await prisma.reliabilityClientConfig.create(args);}
      catch (error) {if ((error as {code?: string}).code === 'P2002') conflicts++;throw error;}
    },
  }});
  const rows = await Promise.all([init('test-race@example.com', clientId, 'opencode'), init('test-race@example.com', clientId, 'opencode')]);
  assert.equal(conflicts, 1, 'Both first reads must race through the real database uniqueness check');
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(await prisma.reliabilityClientConfig.count(), 1);
  await prisma.reliabilityClientConfig.update({where: {id: rows[0].id}, data: {revision: 7, overrideJson: '{"enabled":false}'}});
  const retained = await init('test-race@example.com', clientId, 'opencode');
  assert.equal(retained.revision, 7);
  assert.equal(retained.overrideJson, '{"enabled":false}');
});

test('初始化配置不吞掉数据库超时', async () => {
  const failure = Object.assign(new Error('Database timeout'), {code: 'P1008'});
  const init = initializer({reliabilityClientConfig: {findUnique: async () => null, create: async () => {throw failure;}}});
  await assert.rejects(init('test-race@example.com', 'test-client', 'opencode'), error => error === failure);
});

test('唯一冲突后没有同一客户端平台记录时保留原错误', async () => {
  const failure = Object.assign(new Error('Other uniqueness conflict'), {code: 'P2002'});
  const init = initializer({reliabilityClientConfig: {findUnique: async () => null, create: async () => {throw failure;}}});
  await assert.rejects(init('test-race@example.com', 'test-client', 'opencode'), error => error === failure);
});
