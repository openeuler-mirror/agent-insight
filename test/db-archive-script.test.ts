import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const archiveScript = path.join(projectRoot, 'scripts', 'db_archive.sh');

function hasCommand(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const canRun = hasCommand('bash') && hasCommand('sqlite3') && hasCommand('gzip');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function runScript(args: string[]): string {
  return execFileSync('bash', [archiveScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Asia/Shanghai' },
  });
}

test('archive script runs independently outside the repository', {
  skip: !canRun,
}, () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-insight-standalone-archive-'));
  try {
    const standaloneScript = path.join(tempRoot, 'db_archive.sh');
    const sourceDb = path.join(tempRoot, 'source.sqlite');
    const archiveFile = path.join(tempRoot, 'traces.sqlite.gz');
    copyFileSync(archiveScript, standaloneScript);
    sqlite(sourceDb, traceSchema());
    sqlite(sourceDb, `
      INSERT INTO "Execution"
        (id, taskId, timestamp, user, parentExecutionId, rootExecutionId, isSubagent)
      VALUES ('old-root', 'old-task', 1577836800000, 'alice', NULL, NULL, 0);
      INSERT INTO "Session" (id, taskId, startTime)
      VALUES ('session-old-root', 'old-task', 1577836800000);
    `);

    execFileSync('bash', [
      standaloneScript,
      'create',
      '--database', sourceDb,
      '--scope', 'traces',
      '--before', '2025-01-01',
      '--output', archiveFile,
    ], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' },
    });

    assert.equal(existsSync(archiveFile), true);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '0');
    execFileSync('bash', [
      standaloneScript,
      'import',
      '--database', sourceDb,
      '--input', archiveFile,
    ], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' },
    });
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '1');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function traceSchema(): string {
  return `
    PRAGMA foreign_keys=ON;
    CREATE TABLE "Execution" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "taskId" TEXT,
      "timestamp" DATETIME NOT NULL,
      "user" TEXT,
      "parentExecutionId" TEXT,
      "rootExecutionId" TEXT,
      "isSubagent" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "Session" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "taskId" TEXT NOT NULL UNIQUE,
      "startTime" DATETIME NOT NULL
    );
    CREATE TABLE "ExecutionSkill" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "executionId" TEXT NOT NULL,
      "skillName" TEXT NOT NULL,
      CONSTRAINT "ExecutionSkill_executionId_fkey"
        FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Skill" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL
    );
    CREATE TABLE "SkillVersion" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "skillId" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      CONSTRAINT "SkillVersion_skillId_fkey"
        FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Evaluation" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "skillId" TEXT NOT NULL,
      "executionId" TEXT,
      CONSTRAINT "Evaluation_skillId_fkey"
        FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE,
      CONSTRAINT "Evaluation_executionId_fkey"
        FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE SET NULL
    );
    CREATE TABLE "SkillIssue" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "evaluationId" TEXT NOT NULL,
      "skillId" TEXT NOT NULL,
      CONSTRAINT "SkillIssue_evaluationId_fkey"
        FOREIGN KEY ("evaluationId") REFERENCES "Evaluation" ("id") ON DELETE CASCADE,
      CONSTRAINT "SkillIssue_skillId_fkey"
        FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Tag" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL
    );
    CREATE TABLE "ExecutionTag" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "executionId" TEXT NOT NULL,
      "tagId" TEXT NOT NULL,
      CONSTRAINT "ExecutionTag_executionId_fkey"
        FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE,
      CONSTRAINT "ExecutionTag_tagId_fkey"
        FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Experiment" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL
    );
    CREATE TABLE "ExperimentCase" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "experimentId" TEXT NOT NULL,
      "executionId" TEXT,
      CONSTRAINT "ExperimentCase_experimentId_fkey"
        FOREIGN KEY ("experimentId") REFERENCES "Experiment" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "ExperimentEvalResult" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "experimentId" TEXT NOT NULL,
      "caseId" TEXT NOT NULL,
      CONSTRAINT "ExperimentEvalResult_caseId_fkey"
        FOREIGN KEY ("caseId") REFERENCES "ExperimentCase" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "ExperimentEvalComment" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "experimentId" TEXT NOT NULL,
      "caseId" TEXT,
      "resultId" TEXT,
      CONSTRAINT "ExperimentEvalComment_experimentId_fkey"
        FOREIGN KEY ("experimentId") REFERENCES "Experiment" ("id") ON DELETE CASCADE
    );
  `;
}

test('trace archive preserves a complete execution tree and supports guarded idempotent restore', {
  skip: !canRun,
}, () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-insight-db-archive-'));
  try {
    const sourceDb = path.join(tempRoot, 'source.sqlite');
    const archiveFile = path.join(tempRoot, 'traces.sqlite.gz');
    const allUsersArchive = path.join(tempRoot, 'traces-all-users.sqlite.gz');
    const unpackedArchive = path.join(tempRoot, 'archive.sqlite');
    sqlite(sourceDb, traceSchema());
    sqlite(sourceDb, `
      INSERT INTO "Execution"
        (id, taskId, timestamp, user, parentExecutionId, rootExecutionId, isSubagent)
      VALUES
        ('old-root', 'old-task', 1577836800000, 'alice', NULL, NULL, 0),
        ('old-child', 'old-child-task', 1893456000000, 'alice', 'old-root', 'old-root', 1),
        ('new-root', 'new-task', 1924992000000, 'alice', NULL, NULL, 0),
        ('bob-old-root', 'bob-old-task', 1577836800000, 'bob', NULL, NULL, 0);
      INSERT INTO "Session" (id, taskId, startTime)
      VALUES
        ('session-old-root', 'old-task', 1577836800000),
        ('session-old-child', 'old-child-task', 1893456000000),
        ('session-new', 'new-task', 1924992000000),
        ('session-bob-old', 'bob-old-task', 1577836800000);
      INSERT INTO "ExecutionSkill" (id, executionId, skillName)
      VALUES
        ('binding-old', 'old-child', 'archive-test'),
        ('binding-new', 'new-root', 'active-test');
      INSERT INTO "Skill" (id, name) VALUES ('skill-1', 'archive-test');
      INSERT INTO "SkillVersion" (id, skillId, version) VALUES ('skill-version-1', 'skill-1', 1);
      INSERT INTO "Evaluation" (id, skillId, executionId) VALUES ('evaluation-old', 'skill-1', 'old-child');
      INSERT INTO "SkillIssue" (id, evaluationId, skillId)
        VALUES ('issue-old', 'evaluation-old', 'skill-1');
      INSERT INTO "Tag" (id, name) VALUES ('tag-1', 'historical');
      INSERT INTO "ExecutionTag" (id, executionId, tagId) VALUES ('execution-tag-old', 'old-root', 'tag-1');
      INSERT INTO "Experiment" (id, name) VALUES ('experiment-1', 'historical experiment');
      INSERT INTO "ExperimentCase" (id, experimentId, executionId)
        VALUES ('case-old', 'experiment-1', 'old-root');
      INSERT INTO "ExperimentEvalResult" (id, experimentId, caseId)
        VALUES ('result-old', 'experiment-1', 'case-old');
      INSERT INTO "ExperimentEvalComment" (id, experimentId, caseId, resultId)
        VALUES ('comment-old', 'experiment-1', 'case-old', 'result-old');
    `);

    const allUsersDryRun = runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'traces',
      '--before', '2025-01-01',
      '--output', path.join(tempRoot, 'missing-user.sqlite.gz'),
      '--dry-run',
    ]);
    assert.match(allUsersDryRun, /user\s+<all-users>/);
    assert.match(allUsersDryRun, /Execution\s+3/);

    const dryRunOutput = runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'traces',
      '--user', 'alice',
      '--before', '2025-01-01T00:00:00Z',
      '--output', archiveFile,
      '--dry-run',
    ]);
    assert.match(dryRunOutput, /Execution\s+2/);
    assert.equal(existsSync(archiveFile), false);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '4');

    runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'traces',
      '--user', 'alice',
      '--before', '2025-01-01T00:00:00Z',
      '--output', archiveFile,
    ]);

    assert.equal(existsSync(archiveFile), true);
    assert.equal(existsSync(`${archiveFile}.sha256`), true);
    assert.equal(existsSync(`${archiveFile}.purged`), true);
    assert.match(runScript(['inspect', '--input', archiveFile]), /schemaHash/);
    assert.equal(
      sqlite(sourceDb, 'SELECT group_concat(id) FROM (SELECT id FROM "Execution" ORDER BY id);'),
      'bob-old-root,new-root',
    );
    assert.equal(sqlite(sourceDb, 'SELECT group_concat(id) FROM "ExecutionSkill" ORDER BY id;'), 'binding-new');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Evaluation";'), '0');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "SkillIssue";'), '0');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "ExperimentCase";'), '0');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Skill";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Tag";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Experiment";'), '1');

    writeFileSync(unpackedArchive, gunzipSync(readFileSync(archiveFile)));
    assert.equal(sqlite(unpackedArchive, 'SELECT COUNT(*) FROM "Execution";'), '2');
    assert.equal(sqlite(unpackedArchive, 'SELECT COUNT(*) FROM "ExecutionSkill";'), '1');
    assert.equal(sqlite(unpackedArchive, 'SELECT COUNT(*) FROM "Evaluation";'), '1');
    assert.equal(sqlite(unpackedArchive, 'SELECT COUNT(*) FROM "SkillIssue";'), '1');
    assert.equal(sqlite(unpackedArchive, 'SELECT COUNT(*) FROM "ExperimentEvalComment";'), '1');
    assert.equal(
      sqlite(unpackedArchive, 'SELECT rootExecutionId FROM "Execution" WHERE id = \'old-child\';'),
      'old-root',
    );

    sqlite(sourceDb, `
      INSERT INTO "Execution"
        (id, taskId, timestamp, user, parentExecutionId, rootExecutionId, isSubagent)
      VALUES ('old-root', 'conflicting-task', 1577836800000, 'alice', NULL, NULL, 0);
    `);
    const dryRunConflict = spawnSync('bash', [
      archiveScript,
      'import',
      '--database', sourceDb,
      '--input', archiveFile,
      '--dry-run',
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.notEqual(dryRunConflict.status, 0);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution" WHERE id = \'old-child\';'), '0');

    const conflict = spawnSync('bash', [
      archiveScript,
      'import',
      '--database', sourceDb,
      '--input', archiveFile,
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.notEqual(conflict.status, 0);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution" WHERE id = \'old-child\';'), '0');

    sqlite(sourceDb, 'DELETE FROM "Execution" WHERE id = \'old-root\';');
    runScript(['import', '--database', sourceDb, '--input', archiveFile]);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '4');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Session";'), '4');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "ExecutionSkill";'), '2');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Evaluation";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "SkillIssue";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "ExperimentCase";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "ExperimentEvalResult";'), '1');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "ExperimentEvalComment";'), '1');

    runScript(['import', '--database', sourceDb, '--input', archiveFile]);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '4');

    runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'traces',
      '--before', '2025-01-01',
      '--output', allUsersArchive,
    ]);
    assert.equal(
      sqlite(sourceDb, 'SELECT group_concat(id) FROM (SELECT id FROM "Execution" ORDER BY id);'),
      'new-root',
    );
    runScript(['import', '--database', sourceDb, '--input', allUsersArchive]);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "Execution";'), '4');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('infra metric archive uses the requested half-open time window', {
  skip: !canRun,
}, () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-insight-metric-archive-'));
  try {
    const sourceDb = path.join(tempRoot, 'source.sqlite');
    const archiveFile = path.join(tempRoot, 'metrics.sqlite.gz');
    const keepSourceArchive = path.join(tempRoot, 'metrics-keep-source.sqlite.gz');
    sqlite(sourceDb, `
      PRAGMA foreign_keys=ON;
      CREATE TABLE "InfraSource" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "endpoint" TEXT NOT NULL UNIQUE
      );
      CREATE TABLE "InfraMetricSample" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        "tsMs" REAL NOT NULL,
        "gauges" TEXT NOT NULL,
        CONSTRAINT "InfraMetricSample_sourceId_fkey"
          FOREIGN KEY ("sourceId") REFERENCES "InfraSource" ("id") ON DELETE CASCADE
      );
      INSERT INTO "InfraSource" (id, endpoint) VALUES ('infra-1', 'http://localhost:8000');
      INSERT INTO "InfraMetricSample" (id, sourceId, tsMs, gauges)
      VALUES
        ('before', 'infra-1', 1577836799999, '{}'),
        ('from-inclusive', 'infra-1', 1577836800000, '{}'),
        ('inside', 'infra-1', 1590969600000, '{}'),
        ('to-exclusive', 'infra-1', 1609459200000, '{}');
    `);

    const fractionalDryRun = runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'infra-metrics',
      '--before', '2020-01-01T00:00:00.500Z',
      '--output', path.join(tempRoot, 'fractional.sqlite.gz'),
      '--dry-run',
    ]);
    assert.match(fractionalDryRun, /InfraMetricSample\s+2/);

    const dateOnlyDryRun = runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'infra-metrics',
      '--from', '2020-01-01',
      '--to', '2021-01-01',
      '--output', path.join(tempRoot, 'date-only.sqlite.gz'),
      '--dry-run',
    ]);
    assert.match(dateOnlyDryRun, /InfraMetricSample\s+3/);

    runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'infra-metrics',
      '--before', '2020-01-01T00:00:00Z',
      '--output', keepSourceArchive,
      '--keep-source',
    ]);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "InfraMetricSample";'), '4');
    assert.equal(existsSync(`${keepSourceArchive}.purged`), false);

    runScript([
      'create',
      '--database', sourceDb,
      '--scope', 'infra-metrics',
      '--from', '2020-01-01T00:00:00Z',
      '--to', '2021-01-01T00:00:00Z',
      '--output', archiveFile,
    ]);

    assert.equal(
      sqlite(sourceDb, 'SELECT group_concat(id, \',\') FROM "InfraMetricSample" ORDER BY tsMs;'),
      'before,to-exclusive',
    );
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "InfraSource";'), '1');

    runScript(['import', '--database', sourceDb, '--input', archiveFile]);
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "InfraMetricSample";'), '4');
    assert.equal(sqlite(sourceDb, 'SELECT COUNT(*) FROM "InfraSource";'), '1');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
