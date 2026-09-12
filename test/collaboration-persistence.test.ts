import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('collaboration persistence, late trace resolution, and Goal Plus projection are idempotent', async t => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'collaboration-persistence-'));
  const databasePath = path.join(temporary, 'test.db');
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.AGENT_INSIGHT_LOG_DIR = temporary;
  t.after(async () => {
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    CREATE TABLE "Execution" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "taskId" TEXT,
      "framework" TEXT,
      "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "user" TEXT,
      "parentExecutionId" TEXT,
      "rootExecutionId" TEXT,
      "agentSessionId" TEXT,
      "agentName" TEXT,
      "subagentName" TEXT,
      "isSubagent" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "Session" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "taskId" TEXT NOT NULL,
      "label" TEXT,
      "query" TEXT,
      "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "endTime" DATETIME,
      "interactions" TEXT,
      "langfuseTraceNodes" TEXT,
      "user" TEXT,
      "model" TEXT
    );
    CREATE UNIQUE INDEX "Session_taskId_key" ON "Session"("taskId");
    CREATE TABLE "GoalPlusSource" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "user" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "workspaceFingerprint" TEXT NOT NULL,
      "label" TEXT,
      "collectorVersion" TEXT,
      "sourceSchemaVersion" INTEGER,
      "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastScanCompletedAt" DATETIME,
      "semanticCheckpointJson" TEXT
    );
    CREATE UNIQUE INDEX "GoalPlusSource_user_sourceId_key" ON "GoalPlusSource"("user", "sourceId");
    CREATE TABLE "GoalPlusGoal" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceDbId" TEXT NOT NULL,
      "goalPlusId" TEXT NOT NULL,
      "currentRevision" INTEGER NOT NULL,
      "status" TEXT NOT NULL,
      "phase" TEXT NOT NULL,
      "goalDigest" TEXT NOT NULL,
      "boundedGoal" TEXT,
      "policyJson" TEXT NOT NULL DEFAULT '{}',
      "triageJson" TEXT,
      "revisionsJson" TEXT NOT NULL DEFAULT '[]',
      "workItemsJson" TEXT NOT NULL DEFAULT '[]',
      "searchTasksJson" TEXT NOT NULL DEFAULT '[]',
      "finalChecksJson" TEXT NOT NULL DEFAULT '[]',
      "activeSessionJson" TEXT,
      "nextActionJson" TEXT,
      "sourceCreatedAt" DATETIME,
      "sourceUpdatedAt" DATETIME,
      "observedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "GoalPlusGoal_sourceDbId_goalPlusId_key" ON "GoalPlusGoal"("sourceDbId", "goalPlusId");
    CREATE TABLE "GoalPlusRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceDbId" TEXT NOT NULL,
      "goalDbId" TEXT,
      "runId" TEXT NOT NULL,
      "frozenSpecId" TEXT NOT NULL,
      "sourceRunId" TEXT,
      "replacementRunId" TEXT,
      "state" TEXT NOT NULL,
      "strategy" TEXT,
      "metricName" TEXT,
      "metricDirection" TEXT,
      "bestCandidateId" TEXT,
      "bestScore" REAL,
      "selectedCandidateId" TEXT,
      "selectedIteration" INTEGER,
      "selectedScore" REAL,
      "selectedGitHead" TEXT,
      "selectedArtifactHash" TEXT,
      "invalidationReason" TEXT,
      "invalidationSummary" TEXT,
      "budgetUsedJson" TEXT NOT NULL DEFAULT '{}',
      "selectedModelsJson" TEXT NOT NULL DEFAULT '[]',
      "bestJson" TEXT,
      "reportJson" TEXT,
      "sourceCreatedAt" DATETIME,
      "invalidatedAt" DATETIME,
      "observedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "GoalPlusRun_sourceDbId_runId_key" ON "GoalPlusRun"("sourceDbId", "runId");
    CREATE TABLE "GoalPlusAgentSession" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runDbId" TEXT NOT NULL,
      "candidateDbId" TEXT,
      "agentSessionId" TEXT NOT NULL,
      "host" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "nativeSessionId" TEXT,
      "taskName" TEXT,
      "transcriptFingerprint" TEXT,
      "selectedModel" TEXT,
      "usageJson" TEXT NOT NULL DEFAULT '{}',
      "hostMetadataJson" TEXT NOT NULL DEFAULT '{}',
      "countersJson" TEXT NOT NULL DEFAULT '{}',
      "sourceCreatedAt" DATETIME,
      "sourceUpdatedAt" DATETIME,
      "observedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "GoalPlusAgentSession_runDbId_agentSessionId_key" ON "GoalPlusAgentSession"("runDbId", "agentSessionId");
    CREATE TABLE "GoalPlusExecutionLink" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceDbId" TEXT NOT NULL,
      "goalDbId" TEXT,
      "runDbId" TEXT,
      "candidateDbId" TEXT,
      "agentSessionDbId" TEXT,
      "executionId" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "linkMethod" TEXT NOT NULL,
      "linkState" TEXT NOT NULL,
      "priority" INTEGER NOT NULL,
      "evidenceJson" TEXT,
      "linkedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "GoalPlusExecutionLink_sourceDbId_executionId_role_key"
      ON "GoalPlusExecutionLink"("sourceDbId", "executionId", "role");
    CREATE TABLE "Collaboration" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "user" TEXT NOT NULL,
      "collaborationId" TEXT NOT NULL,
      "sourceType" TEXT NOT NULL DEFAULT 'reported',
      "sourceRef" TEXT,
      "diagnosticsJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX "Collaboration_user_collaborationId_key" ON "Collaboration"("user", "collaborationId");
    CREATE UNIQUE INDEX "Collaboration_user_sourceType_sourceRef_key" ON "Collaboration"("user", "sourceType", "sourceRef");
    CREATE TABLE "CollaborationEvent" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "collaborationDbId" TEXT NOT NULL,
      "user" TEXT NOT NULL,
      "collaborationId" TEXT NOT NULL,
      "eventId" TEXT NOT NULL,
      "fromSessionId" TEXT NOT NULL,
      "toSessionId" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "observedAt" DATETIME,
      "content" TEXT,
      "fromLocatorJson" TEXT,
      "sourceType" TEXT NOT NULL DEFAULT 'reported',
      "sourceRef" TEXT,
      "relationKind" TEXT,
      "role" TEXT,
      "bodyJson" TEXT NOT NULL,
      "bodyHash" TEXT NOT NULL,
      "receivedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX "CollaborationEvent_collaborationDbId_eventId_key"
      ON "CollaborationEvent"("collaborationDbId", "eventId");
    CREATE UNIQUE INDEX "CollaborationEvent_user_collaborationId_eventId_key"
      ON "CollaborationEvent"("user", "collaborationId", "eventId");
    CREATE TABLE "CollaborationSessionBinding" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "user" TEXT NOT NULL,
      "collaborationId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "traceSessionId" TEXT NOT NULL,
      "eventClock" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX "CollaborationSessionBinding_user_collaborationId_sessionId_key"
      ON "CollaborationSessionBinding"("user", "collaborationId", "sessionId");
    CREATE TABLE "CollaborationEndpointResolution" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "eventDbId" TEXT NOT NULL,
      "side" TEXT NOT NULL,
      "executionId" TEXT,
      "linkState" TEXT NOT NULL DEFAULT 'pending',
      "linkMethod" TEXT,
      "evidenceJson" TEXT NOT NULL DEFAULT '{}',
      "anchorState" TEXT,
      "anchorJson" TEXT,
      "resolvedAt" DATETIME,
      "updatedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "CollaborationEndpointResolution_eventDbId_side_key"
      ON "CollaborationEndpointResolution"("eventDbId", "side");
  `]);

  const { prismaRaw } = await import('@/lib/storage/prisma');
  t.after(async () => {
    await prismaRaw.$disconnect();
  });
  const {
    CollaborationConflictError,
    persistCollaborationEvent,
  } = await import('@/lib/ingest/collaboration/persist');
  const {
    resolveCollaborationEventByDbId,
  } = await import('@/lib/ingest/collaboration/resolve');
  const {
    goalPlusCollaborationIdentity,
    projectGoalPlusCollaborations,
  } = await import('@/lib/ingest/collaboration/providers/goal-plus');
  const { CollaborationStore, sqlDatabase } = await import('@/lib/collaboration/store');
  const { CollaborationService } = await import('@/lib/collaboration/service');

  const reported = {
    collaborationId: 'collab_reported',
    eventId: 'evt_reported',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    description: '启动 worker',
    fromLocator: { recordType: 'tool' as const, name: 'spawn_agent' },
    sourceType: 'reported' as const,
  };
  const created = await persistCollaborationEvent('alice', reported);
  assert.equal(created.result, 'created');
  assert.equal((await persistCollaborationEvent('alice', reported)).result, 'duplicate');
  await assert.rejects(
    () => persistCollaborationEvent('alice', { ...reported, description: '修改后的正文' }),
    CollaborationConflictError,
  );

  const reportedStore = new CollaborationStore(sqlDatabase(prismaRaw));
  const storedByReportedPath = await reportedStore.saveEvent('alice', {
    collaborationId: 'collab_remote_path',
    eventId: 'evt_remote_path',
    fromSessionId: 'remote-session-a',
    toSessionId: 'remote-session-b',
    description: '显式 Session 绑定路径',
  });
  assert.equal(storedByReportedPath.result, 'created');
  const compatibleEvent = await prismaRaw.collaborationEvent.findUnique({
    where: {
      user_collaborationId_eventId: {
        user: 'alice', collaborationId: 'collab_remote_path', eventId: 'evt_remote_path',
      },
    },
    include: { endpointResolutions: true },
  });
  assert.equal(compatibleEvent?.collaborationDbId !== null, true);
  assert.equal(compatibleEvent?.endpointResolutions.length, 2);

  const reportedService = new CollaborationService(reportedStore);
  const serviceResult = await reportedService.report('alice', {
    collaborationId: 'collab_service_path',
    eventId: 'evt_service_path',
    fromSessionId: 'service-session-a',
    toSessionId: 'service-session-b',
    description: 'token=service-secret',
  });
  assert.equal(serviceResult.result, 'created');
  assert.equal(serviceResult.endpointResolutions?.from.status, 'unresolved');
  const serviceEvent = await prismaRaw.collaborationEvent.findUnique({
    where: {
      user_collaborationId_eventId: {
        user: 'alice', collaborationId: 'collab_service_path', eventId: 'evt_service_path',
      },
    },
  });
  assert.doesNotMatch(serviceEvent?.eventBodyJson || '', /service-secret/);

  await resolveCollaborationEventByDbId(created.eventDbId);
  let resolutions = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId: created.eventDbId },
  });
  assert.deepEqual(resolutions.map(row => row.linkState).sort(), ['pending', 'pending']);

  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "agentSessionId", "user", "framework", "parentExecutionId") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
    'exec-a', 'session-a', 'session-a', 'alice', 'opencode', null,
    'exec-b', 'session-b', 'session-b', 'alice', 'opencode', 'exec-a',
    'other-user-exec', 'session-a', 'session-a', 'bob', 'opencode', null,
  );
  await prismaRaw.session.create({
    data: {
      taskId: 'session-a',
      user: 'alice',
      interactions: JSON.stringify([{
        tool_calls: [{
          id: 'spawn-call',
          function: { name: 'spawn_agent', arguments: '{}' },
          timing: { started_at: 100, source: 'execution' },
        }],
      }]),
    },
  });
  await resolveCollaborationEventByDbId(created.eventDbId);
  resolutions = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId: created.eventDbId },
  });
  assert.equal(resolutions.every(row => row.linkState === 'linked'), true);
  assert.equal(resolutions.find(row => row.side === 'from')?.anchorState, 'candidate');

  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "agentSessionId", "user", "framework") VALUES (?, ?, ?, ?, ?)',
    'exec-c', 'session-c', 'session-c', 'alice', 'opencode',
  );
  await prismaRaw.session.update({
    where: { taskId: 'session-a' },
    data: {
      interactions: JSON.stringify([{
        tool_calls: [
          {
            id: 'spawn-call-1',
            function: { name: 'spawn_agent', arguments: '{}' },
            timing: { started_at: 100, source: 'execution' },
          },
          {
            id: 'spawn-call-2',
            function: { name: 'spawn_agent', arguments: '{}' },
            timing: { started_at: 200, source: 'execution' },
          },
        ],
      }]),
    },
  });
  const orderedFirst = await persistCollaborationEvent('alice', {
    ...reported,
    collaborationId: 'collab_ordered',
    eventId: 'evt_ordered_1',
    observedAt: '2026-09-12T00:00:01Z',
  });
  const orderedSecond = await persistCollaborationEvent('alice', {
    ...reported,
    collaborationId: 'collab_ordered',
    eventId: 'evt_ordered_2',
    toSessionId: 'session-c',
    observedAt: '2026-09-12T00:00:02Z',
  });
  await resolveCollaborationEventByDbId(orderedFirst.eventDbId);
  await resolveCollaborationEventByDbId(orderedSecond.eventDbId);
  const orderedAnchors = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId: { in: [orderedFirst.eventDbId, orderedSecond.eventDbId] }, side: 'from' },
    orderBy: { eventDbId: 'asc' },
  });
  assert.equal(orderedAnchors.every(row => row.anchorState === 'time_ordered'), true);
  assert.deepEqual(
    orderedAnchors.map(row => JSON.parse(row.anchorJson || '{}').orderIndex).sort(),
    [1, 2],
  );

  const source = await prismaRaw.goalPlusSource.create({
    data: {
      user: 'alice',
      sourceId: 'gpsrc-projection',
      workspaceFingerprint: `sha256:${'a'.repeat(64)}`,
    },
  });
  const goal = await prismaRaw.goalPlusGoal.create({
    data: {
      sourceDbId: source.id,
      goalPlusId: 'goal-projection',
      currentRevision: 1,
      status: 'running',
      phase: 'search',
      goalDigest: 'digest',
      observedAt: new Date('2026-09-12T00:00:00Z'),
    },
  });
  const run = await prismaRaw.goalPlusRun.create({
    data: {
      sourceDbId: source.id,
      goalDbId: goal.id,
      runId: 'run-projection',
      frozenSpecId: 'spec-projection',
      state: 'running',
      observedAt: new Date('2026-09-12T00:00:00Z'),
    },
  });
  const workerSession = await prismaRaw.goalPlusAgentSession.create({
    data: {
      runDbId: run.id,
      agentSessionId: 'worker-projection',
      host: 'pi-rpc',
      role: 'candidate-worker',
      observedAt: new Date('2026-09-12T00:00:00Z'),
    },
  });
  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "user", "framework") VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    'goal-main', 'goal-main-session', 'alice', 'pi-agent',
    'goal-worker', 'goal-plus:gpsrc-projection:worker-projection', 'alice', 'pi-agent',
  );
  await prismaRaw.goalPlusExecutionLink.createMany({
    data: [
      {
        sourceDbId: source.id,
        goalDbId: goal.id,
        executionId: 'goal-main',
        role: 'main',
        linkMethod: 'native_session_id',
        linkState: 'linked',
        priority: 1,
      },
      {
        sourceDbId: source.id,
        goalDbId: goal.id,
        runDbId: run.id,
        agentSessionDbId: workerSession.id,
        executionId: 'goal-worker',
        role: 'candidate-worker',
        linkMethod: 'pi_native_passive',
        linkState: 'linked',
        priority: 3,
      },
    ],
  });
  const firstProjection = await projectGoalPlusCollaborations(source.id);
  const secondProjection = await projectGoalPlusCollaborations(source.id);
  assert.equal(firstProjection.projectedEvents, 1);
  assert.equal(secondProjection.projectedEvents, 1);
  const identity = goalPlusCollaborationIdentity(source.sourceId, goal.goalPlusId);
  const collaboration = await prismaRaw.collaboration.findUnique({
    where: { user_collaborationId: { user: 'alice', collaborationId: identity.collaborationId } },
    include: { events: { include: { endpointResolutions: true } } },
  });
  assert.equal(collaboration?.sourceType, 'goal-plus-semantic');
  assert.equal(collaboration?.events.length, 1);
  assert.equal(collaboration?.events[0].endpointResolutions.every(row => row.linkState === 'linked'), true);

  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "user", "framework") VALUES (?, ?, ?, ?)',
    'goal-main-2', 'goal-main-session-2', 'alice', 'pi-agent',
  );
  await prismaRaw.goalPlusExecutionLink.create({
    data: {
      sourceDbId: source.id,
      goalDbId: goal.id,
      executionId: 'goal-main-2',
      role: 'main',
      linkMethod: 'native_session_id',
      linkState: 'linked',
      priority: 1,
    },
  });
  await projectGoalPlusCollaborations(source.id);
  const fromResolution = await prismaRaw.collaborationEndpointResolution.findFirst({
    where: { eventDbId: collaboration!.events[0].id, side: 'from' },
  });
  assert.equal(fromResolution?.linkState, 'ambiguous');
  const updated = await prismaRaw.collaboration.findUnique({ where: { id: collaboration!.id } });
  assert.match(updated?.diagnosticsJson || '', /ambiguous-main-session/);
});
