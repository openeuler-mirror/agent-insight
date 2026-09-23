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
    CREATE TABLE "GoalPlusCandidate" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL);
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
    resolveCollaborationEndpointsForExecution,
    resolveCollaborationEventByDbId,
  } = await import('@/lib/ingest/collaboration/resolve');
  const {
    goalPlusCollaborationIdentity,
    projectGoalPlusCollaborations,
  } = await import('@/lib/ingest/collaboration/providers/goal-plus');
  const {
    findGoalPlusTraceProjectionMembers,
    goalPlusProjectedWorkerExecutionWhere,
    parsePiTaskSessionId,
  } = await import('@/lib/ingest/collaboration/query');
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

  const boundCollaborationId = `gp.${'b'.repeat(32)}`;
  const boundEventResult = await reportedService.report('alice', {
    collaborationId: boundCollaborationId,
    eventId: 'evt_bound_sessions',
    fromSessionId: 'main',
    toSessionId: 'worker:run-b:search-b',
    description: '逻辑会话通过 binding 关联真实 Trace',
  });
  await reportedService.bind('alice', {
    collaborationId: boundCollaborationId,
    sessionId: 'main',
    traceSessionId: 'bound-main-trace',
    eventClock: 'source_session',
  });
  await reportedService.bind('alice', {
    collaborationId: boundCollaborationId,
    sessionId: 'worker:run-b:search-b',
    traceSessionId: 'bound-worker-trace',
    eventClock: 'source_session',
  });
  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "agentSessionId", "user", "framework") VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
    'bound-main-execution', 'bound-main-trace', 'bound-main-trace', 'alice', 'pi-agent',
    'bound-worker-execution', 'bound-worker-trace', 'bound-worker-trace', 'alice', 'pi-agent',
  );
  await resolveCollaborationEndpointsForExecution('alice', ['bound-main-trace', 'bound-worker-trace']);
  const boundEvent = await prismaRaw.collaborationEvent.findUnique({
    where: { user_collaborationId_eventId: { user: 'alice', collaborationId: boundCollaborationId, eventId: boundEventResult.eventId } },
  });
  const boundResolutions = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId: boundEvent!.id },
    orderBy: { side: 'asc' },
  });
  assert.deepEqual(boundResolutions.map(row => row.linkState), ['linked', 'linked']);
  assert.deepEqual(boundResolutions.map(row => row.linkMethod), ['session_binding', 'session_binding']);
  assert.deepEqual(
    boundResolutions.map(row => JSON.parse(row.evidenceJson).traceSessionId).sort(),
    ['bound-main-trace', 'bound-worker-trace'],
  );

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
      searchTasksJson: JSON.stringify([{ runId: 'run-projection' }]),
      activeSessionJson: JSON.stringify({
        sessionId: 'goal-main-session',
        nativeSessionId: 'pi-native-main',
        mainSessions: [{
          sessionId: 'goal-main-session',
          nativeSessionId: 'pi-native-main',
        }],
      }),
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
  await prismaRaw.session.create({ data: {
    taskId: 'goal-plus:gpsrc-projection:worker-projection', user: 'alice',
    interactions: JSON.stringify([{ role: 'assistant', content: 'worker result' }]),
  } });
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
  const traceProjection = await findGoalPlusTraceProjectionMembers('alice', 'goal-main-session');
  assert.equal(traceProjection.members.length, 1);
  assert.equal(traceProjection.members[0].taskId, 'goal-plus:gpsrc-projection:worker-projection');
  assert.equal(traceProjection.members[0].anchorState, 'not_provided');
  assert.equal(traceProjection.rootResolution, 'exact-link');
  assert.deepEqual(parsePiTaskSessionId('pi-native-main__task12'), {
    baseSessionId: 'pi-native-main',
    taskIndex: 12,
  });
  assert.equal(parsePiTaskSessionId('pi-native-main'), null);

  const activeCanonicalTaskId = 'goal-plus:gpsrc-projection:main-current-projection';
  await prismaRaw.goalPlusGoal.update({
    where: { id: goal.id },
    data: {
      activeSessionJson: JSON.stringify({
        sessionId: 'pi-native-main',
        mainSessions: [
          { sessionId: 'goal-plus:gpsrc-projection:main-old-projection', nativeSessionId: 'pi-native-old' },
          { sessionId: activeCanonicalTaskId, nativeSessionId: 'pi-native-main' },
        ],
      }),
    },
  });
  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "user", "framework") VALUES (?, ?, ?, ?)',
    'goal-main-active-canonical', activeCanonicalTaskId, 'alice', 'pi-agent',
  );
  await prismaRaw.session.create({
    data: {
      taskId: activeCanonicalTaskId,
      user: 'alice',
      query: '/goal-plus optimize projection',
      interactions: '[]',
    },
  });
  const activeCanonicalProjection = await findGoalPlusTraceProjectionMembers(
    'alice',
    activeCanonicalTaskId,
    '/goal-plus optimize projection',
  );
  assert.equal(activeCanonicalProjection.members.length, 1);
  assert.equal(activeCanonicalProjection.rootResolution, 'active-session-alias');
  assert.equal((await findGoalPlusTraceProjectionMembers('alice', 'goal-main-session')).members.length, 0,
    'an old linked main must not inherit workers after the active session changes');
  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "user", "framework") VALUES (?, ?, ?, ?)',
    'goal-main-stale-canonical', 'goal-plus:gpsrc-projection:main-old-projection', 'alice', 'pi-agent',
  );
  const staleCanonicalProjection = await findGoalPlusTraceProjectionMembers(
    'alice',
    'goal-plus:gpsrc-projection:main-old-projection',
    '/goal-plus optimize projection',
  );
  assert.equal(staleCanonicalProjection.members.length, 0);

  await prismaRaw.$executeRawUnsafe(
    'INSERT INTO "Execution" ("id", "taskId", "user", "framework") VALUES (?, ?, ?, ?)',
    'goal-main-pi-task', 'pi-native-main__task0', 'alice', 'pi-agent',
  );
  await prismaRaw.session.create({
    data: {
      taskId: 'pi-native-main__task0',
      user: 'alice',
      query: '/goal-plus optimize projection',
      interactions: '[]',
    },
  });
  const piAliasProjection = await findGoalPlusTraceProjectionMembers(
    'alice',
    'pi-native-main__task0',
    '/goal-plus optimize projection',
  );
  assert.equal(piAliasProjection.members.length, 1);
  assert.equal(piAliasProjection.rootResolution, 'pi-task-alias');
  const ordinaryPiProjection = await findGoalPlusTraceProjectionMembers(
    'alice',
    'pi-native-main__task0',
    'ordinary Pi task',
  );
  assert.equal(ordinaryPiProjection.members.length, 0);
  await prismaRaw.goalPlusGoal.create({
    data: {
      sourceDbId: source.id,
      goalPlusId: 'goal-projection-alias-conflict',
      currentRevision: 1,
      status: 'running',
      phase: 'search',
      goalDigest: 'digest-conflict',
      activeSessionJson: JSON.stringify({ nativeSessionId: 'pi-native-main' }),
      observedAt: new Date('2026-09-12T00:00:01Z'),
    },
  });
  const ambiguousPiAliasProjection = await findGoalPlusTraceProjectionMembers(
    'alice',
    'pi-native-main__task0',
    '/goal-plus optimize projection',
  );
  assert.equal(ambiguousPiAliasProjection.members.length, 0);
  const projectedWorkerWhere = await goalPlusProjectedWorkerExecutionWhere('alice');
  const rootList = await prismaRaw.execution.findMany({
    where: { user: 'alice', isSubagent: false, AND: [{ NOT: projectedWorkerWhere }] },
    select: { id: true },
  });
  assert.equal(rootList.some(row => row.id === 'goal-main'), true);
  assert.equal(rootList.some(row => row.id === 'goal-worker'), false);
  const subagentList = await prismaRaw.execution.findMany({
    where: { user: 'alice', AND: [{ OR: [{ isSubagent: true }, projectedWorkerWhere] }] },
    select: { id: true },
  });
  assert.equal(subagentList.some(row => row.id === 'goal-worker'), true);

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
  const ambiguousProjection = await findGoalPlusTraceProjectionMembers('alice', 'goal-main-session');
  assert.equal(ambiguousProjection.members.length, 0);
  const updated = await prismaRaw.collaboration.findUnique({ where: { id: collaboration!.id } });
  assert.match(updated?.diagnosticsJson || '', /ambiguous-main-session/);

  const { relinkGoalPlusSource } = await import('@/lib/ingest/goal-plus/correlate');
  await t.test('relink rolls back all changes on failure and preserves unchanged link timestamps', async () => {
    const links = () => prismaRaw.goalPlusExecutionLink.findMany({ where: { sourceDbId: source.id }, orderBy: { id: 'asc' } });
    await prismaRaw.goalPlusExecutionLink.updateMany({ where: { executionId: 'goal-worker' }, data: { priority: 99 } });
    const before = await links();
    await prismaRaw.$executeRawUnsafe(`CREATE TRIGGER fail_worker_relink BEFORE UPDATE ON GoalPlusExecutionLink
      WHEN NEW.executionId = 'goal-worker' BEGIN SELECT RAISE(ABORT, 'injected relink failure'); END`);
    await assert.rejects(relinkGoalPlusSource(source.id));
    assert.deepEqual(await links(), before);
    await prismaRaw.$executeRawUnsafe('DROP TRIGGER fail_worker_relink');
    await relinkGoalPlusSource(source.id);
    const linked = await links();
    await relinkGoalPlusSource(source.id);
    assert.deepEqual(await links(), linked, 'idempotent relink must not rewrite timestamps');
  });

  await t.test('current run excludes historical workers; delayed and failed workers remain visible without duplicate continuation nodes', async () => {
    const oldRun = await prismaRaw.goalPlusRun.create({ data: {
      sourceDbId: source.id, goalDbId: goal.id, runId: 'old-run', frozenSpecId: 'old-spec',
      state: 'failed', observedAt: new Date('2026-09-10T00:00:00Z'),
    } });
    for (const [runId, workerId] of [[oldRun.id, 'historical-worker'], [run.id, 'delayed-worker']]) {
      await prismaRaw.goalPlusAgentSession.create({ data: {
        runDbId: runId, agentSessionId: workerId, host: 'pi-rpc', role: 'candidate-worker', observedAt: new Date(),
      } });
      await prismaRaw.$executeRawUnsafe('INSERT INTO Execution (id, taskId, user, framework) VALUES (?, ?, ?, ?)',
        workerId, `goal-plus:gpsrc-projection:${workerId}`, 'alice', 'pi-agent');
    }
    await prismaRaw.session.create({ data: {
      taskId: 'goal-plus:gpsrc-projection:historical-worker', user: 'alice',
      interactions: '[{"role":"assistant","content":"old result"}]',
    } });
    await relinkGoalPlusSource(source.id);
    const current = () => findGoalPlusTraceProjectionMembers('alice', activeCanonicalTaskId);
    assert.deepEqual((await current()).members.map(member => member.executionId), ['goal-worker']);
    assert.deepEqual((await goalPlusProjectedWorkerExecutionWhere('alice')).id.in, ['goal-worker']);
    await prismaRaw.session.create({ data: {
      taskId: 'goal-plus:gpsrc-projection:delayed-worker', user: 'alice',
      interactions: '[{"role":"assistant","content":"timeout","status":"error"}]',
    } });
    assert.equal((await current()).members.length, 2);
    await prismaRaw.goalPlusAgentSession.updateMany({
      where: { agentSessionId: 'delayed-worker' }, data: { countersJson: '{"continuations":2}' },
    });
    const snapshots: number[] = [];
    await Promise.all([
      ...Array.from({ length: 12 }, () => relinkGoalPlusSource(source.id)),
      (async () => { for (let i = 0; i < 12; i++) snapshots.push((await current()).members.length); })(),
    ]);
    assert.deepEqual(snapshots, Array(12).fill(2));
    assert.deepEqual(new Set((await goalPlusProjectedWorkerExecutionWhere('alice')).id.in), new Set(['goal-worker', 'delayed-worker']));
    await prismaRaw.$executeRawUnsafe('INSERT INTO GoalPlusCandidate (id, candidateId) VALUES (?, ?)', 'candidate-current', 'c002');
    await prismaRaw.goalPlusAgentSession.updateMany({ where: { agentSessionId: 'delayed-worker' }, data: { candidateDbId: 'candidate-current' } });
    assert.equal((await current()).members.length, 1, 'a stale link with a different candidate must not be projected');
    await relinkGoalPlusSource(source.id);
    assert.match((await current()).members.find(member => member.executionId === 'delayed-worker')!.role!, /c002/);
    const projection = await projectGoalPlusCollaborations(source.id);
    assert.equal(projection.projectedEvents, 2, 'semantic provider must use the same current run scope');
    await prismaRaw.session.update({ where: { taskId: 'goal-plus:gpsrc-projection:delayed-worker' }, data: {
      interactions: JSON.stringify(Array.from({ length: 20_001 }, () => ({ role: 'assistant', content: 'large trace' }))),
    } });
    assert.equal((await current()).truncated, true);
    assert.equal((await goalPlusProjectedWorkerExecutionWhere('alice')).id.in.includes('delayed-worker'), false,
      'workers exceeding the detail budget must retain an independent list entry');
    await prismaRaw.goalPlusGoal.update({ where: { id: goal.id }, data: { searchTasksJson: '[]' } });
    assert.equal((await current()).members.length, 0, 'missing explicit run scope must not fall back to all goal history');
    assert.deepEqual((await goalPlusProjectedWorkerExecutionWhere('alice')).id.in, []);
  });
});
