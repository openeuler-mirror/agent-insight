import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  benchmarkDispatchDigest,
  canonicalJson,
  type AgentTaskEnvelope,
} from '../packages/benchmark-protocol/src/contracts'
import {
  createBenchmarkDispatchToken,
  createBenchmarkHealthToken,
  deviceCredentialHash,
} from '../packages/benchmark-protocol/src/executor-contracts'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-executor-api-'))
const externalDatabasePath = process.env.BENCHMARK_TEST_DATABASE_PATH?.trim()
const databasePath = externalDatabasePath
  ? path.resolve(externalDatabasePath)
  : path.join(testDir, 'benchmark.db')
process.env.DATABASE_URL = `file:${databasePath}`
process.env.AGENT_INSIGHT_DATA_DIR = path.join(testDir, 'agent-insight-home')

const externalTestUsers = new Set<string>()
const externalTestClientIds = new Set<string>()
const externalTestExperimentIds = new Set<string>()

const executorModule = require('../services/executor/src/index.cjs') as {
  BenchmarkExecutorError: new (
    code: string,
    message: string,
    status?: number,
    retryable?: boolean,
  ) => Error & { code: string; status: number; retryable: boolean }
  GitWorkspaceProvider: new (
    rootDir: string,
    processRunner?: (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<{ stdout: string; stderr: string }>,
    options?: Record<string, unknown>,
  ) => {
    prepare(
      spec: { repository: string; revision: string },
      context: { runId: string },
    ): Promise<{ path: string; baseCommit: string }>
  }
  GitPatchCollector: new (
    processRunner?: (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<{ stdout: string; stderr: string }>,
  ) => {
    collect(
      contract: { name: string; mediaType: string; maxBytes: number },
      context: { workspace: { path: string; baseCommit: string } },
    ): Promise<{ name: string; mediaType: string; bytes: Buffer; sha256: string }>
  }
  createBenchmarkExecutor: (options: Record<string, unknown>) => {
    listen(host?: string, port?: number): Promise<{ port: number }>
    accept(request: Record<string, unknown>): Promise<Record<string, unknown>>
    close(): Promise<void>
    readonly activeRunId: string | null
    recover(): Promise<void>
    store: { state(runId: string): Promise<Record<string, unknown> | null> }
  }
  runProcess: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>
  sha256?: (value: Uint8Array) => string
}

let prisma: typeof import('@/lib/storage/prisma').prisma
let artifactRoute: typeof import('@/app/api/benchmark/v1/artifacts/route').POST
let artifactContentRoute: typeof import('@/app/api/benchmark/v1/artifacts/[artifactId]/content/route').GET
let progressRoute: typeof import('@/app/api/benchmark/v1/runs/[runId]/progress/route').POST
let completeRoute: typeof import('@/app/api/benchmark/v1/runs/[runId]/complete/route').POST
let evaluationProgressRoute: typeof import('@/app/api/benchmark/v1/evaluations/[evaluationId]/progress/route').POST
let evaluationArtifactRoute: typeof import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/route').POST
let evaluationCompleteRoute: typeof import('@/app/api/benchmark/v1/evaluations/[evaluationId]/complete/route').POST
let evaluationArtifactContentRoute: typeof import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/[artifactId]/content/route').GET
let benchmarkExperimentResultRoute: typeof import('@/app/api/benchmark/v1/experiments/[experimentId]/route').GET
let createExperimentRoute: typeof import('@/app/api/experiments/route').POST
let runExperimentRoute: typeof import('@/app/api/experiments/[id]/run/route').POST
let importOfficialDataset:
  typeof import('../benchmarks/swe-bench/dataset').importOfficialSweBenchVerifiedDataset
let setCommandDispatcher: typeof import('@/lib/benchmark/scheduler').setBenchmarkCommandDispatcherForTest

test.before(async () => {
  if (!externalDatabasePath) {
    const sqliteModule = 'node:sqlite'
    const { DatabaseSync } = await import(sqliteModule) as {
      DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void }
    }
    const database = new DatabaseSync(databasePath)
    database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE AgentEvalDataset (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      targetAgent TEXT NOT NULL DEFAULT '', targetSkill TEXT NOT NULL DEFAULT '', tagsJson TEXT NOT NULL DEFAULT '[]',
      fieldsJson TEXT NOT NULL DEFAULT '[]', casesJson TEXT NOT NULL DEFAULT '[]', caseCount INTEGER NOT NULL DEFAULT 0,
      referenceCasesJson TEXT NOT NULL DEFAULT '[]', projectionReady INTEGER NOT NULL DEFAULT 0,
      datasetKind TEXT NOT NULL DEFAULT 'ideal_output', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE Experiment (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'single',
      agentName TEXT NOT NULL DEFAULT '', evaluatorIdsJson TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
      scope TEXT NOT NULL DEFAULT '', skillName TEXT NOT NULL DEFAULT '', skillVersion INTEGER, preset TEXT,
      skillContextJson TEXT, configSnapshotJson TEXT, sourceExperimentId TEXT, optimizationRecordId TEXT,
      watchMode INTEGER NOT NULL DEFAULT 0, watchEnabledAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ExperimentCase (
      id TEXT PRIMARY KEY, experimentId TEXT NOT NULL, executionId TEXT, taskId TEXT, input TEXT NOT NULL DEFAULT '',
      datasetInput TEXT, actualOutput TEXT NOT NULL DEFAULT '', referenceOutput TEXT, evaluatorContextJson TEXT,
      groupId TEXT, faultInjectionType TEXT, caseValuesJson TEXT, fiTaskId TEXT, fiRunId TEXT,
      traceGenerationCommandId TEXT, traceGenerationError TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE
    );
    CREATE TABLE ReliabilityClient (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL UNIQUE, user TEXT NOT NULL, name TEXT NOT NULL, hostname TEXT,
      reportedIp TEXT, observedIp TEXT, os TEXT, arch TEXT, status TEXT NOT NULL DEFAULT 'offline',
      serviceHealth TEXT NOT NULL DEFAULT 'unknown', supervisor TEXT, processStartedAt DATETIME,
      restartCount INTEGER NOT NULL DEFAULT 0, lastSeenAt DATETIME NOT NULL, agentVersion TEXT,
      capabilitiesJson TEXT NOT NULL DEFAULT '{}', capabilitiesRevision TEXT, unboundAt DATETIME,
      unboundToClientId TEXT, machineId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ReliabilityClientCredential (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL, credentialHash TEXT NOT NULL UNIQUE,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, lastUsedAt DATETIME, revokedAt DATETIME,
      FOREIGN KEY (clientId) REFERENCES ReliabilityClient(clientId) ON DELETE CASCADE
    );
    CREATE TABLE BenchmarkDataset (
      id TEXT PRIMARY KEY, agentEvalDatasetId TEXT NOT NULL UNIQUE, user TEXT NOT NULL, name TEXT NOT NULL,
      adapterKey TEXT NOT NULL, contentHash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      caseCount INTEGER NOT NULL DEFAULT 0, sourceJson TEXT NOT NULL DEFAULT '{}',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agentEvalDatasetId) REFERENCES AgentEvalDataset(id) ON DELETE CASCADE,
      UNIQUE (user, name)
    );
    CREATE TABLE BenchmarkDatasetCase (
      id TEXT PRIMARY KEY, datasetId TEXT NOT NULL, externalCaseId TEXT NOT NULL, rawCaseJson TEXT NOT NULL,
      publicPayloadJson TEXT NOT NULL, privatePayloadJson TEXT NOT NULL, sourceFingerprint TEXT NOT NULL,
      publicFingerprint TEXT NOT NULL, privateFingerprint TEXT NOT NULL, ordinal INTEGER NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id) ON DELETE CASCADE,
      UNIQUE (datasetId, externalCaseId), UNIQUE (datasetId, ordinal)
    );
    CREATE TABLE BenchmarkExperimentBinding (
      experimentId TEXT PRIMARY KEY, datasetId TEXT NOT NULL, datasetContentHash TEXT NOT NULL, adapterKey TEXT NOT NULL,
      selectionJson TEXT NOT NULL, runConfigJson TEXT NOT NULL, schedulerStatus TEXT NOT NULL DEFAULT 'idle',
      expectedCaseCount INTEGER NOT NULL, callbackOrigin TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id)
    );
    CREATE TABLE BenchmarkCaseRun (
      id TEXT PRIMARY KEY, experimentId TEXT NOT NULL, experimentCaseId TEXT NOT NULL, datasetCaseId TEXT,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', adapterKey TEXT NOT NULL, clientId TEXT NOT NULL,
      publicPayloadJson TEXT, privatePayloadJson TEXT, taskEnvelopeJson TEXT,
      taskDigest TEXT, progressJson TEXT, runFactsJson TEXT, cleanupJson TEXT, completionDigest TEXT,
      failureCode TEXT, failureMessage TEXT, retryOfRunId TEXT, lastProgressAt DATETIME,
      startedAt DATETIME, finishedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE,
      FOREIGN KEY (experimentCaseId) REFERENCES ExperimentCase(id) ON DELETE CASCADE,
      FOREIGN KEY (datasetCaseId) REFERENCES BenchmarkDatasetCase(id) ON DELETE SET NULL
    );
    CREATE TABLE BenchmarkArtifact (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, name TEXT NOT NULL, mediaType TEXT NOT NULL,
      sha256 TEXT NOT NULL, sizeBytes INTEGER NOT NULL, storagePath TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES BenchmarkCaseRun(id) ON DELETE CASCADE,
      UNIQUE (runId, name)
    );
    CREATE TABLE BenchmarkDispatchOutbox (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'agent_execution',
      commandId TEXT UNIQUE, requestJson TEXT NOT NULL, requestDigest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attemptCount INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, leasedUntil DATETIME,
      responseJson TEXT, errorCode TEXT, errorMessage TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES BenchmarkCaseRun(id) ON DELETE CASCADE
    );
    CREATE TABLE BenchmarkEvaluation (
      id TEXT PRIMARY KEY, caseRunId TEXT NOT NULL, attemptNo INTEGER NOT NULL DEFAULT 1,
      retryOfEvaluationId TEXT, status TEXT NOT NULL DEFAULT 'queued', adapterKey TEXT NOT NULL,
      evaluatorKey TEXT NOT NULL, evaluatorTargetKey TEXT, evaluatorBaseUrl TEXT,
      requestJson TEXT NOT NULL, requestDigest TEXT NOT NULL, callbackBaseUrl TEXT NOT NULL,
      timeoutSeconds INTEGER NOT NULL, progressJson TEXT, rawResultJson TEXT, rawResultDigest TEXT,
      runtimeFactsJson TEXT, cleanupJson TEXT, normalizedResultJson TEXT, completionDigest TEXT,
      failureCode TEXT, failureMessage TEXT, lastProgressAt DATETIME, startedAt DATETIME,
      finishedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caseRunId) REFERENCES BenchmarkCaseRun(id) ON DELETE CASCADE,
      UNIQUE (caseRunId, attemptNo)
    );
    CREATE TABLE BenchmarkEvaluationDispatchOutbox (
      id TEXT PRIMARY KEY, evaluationId TEXT NOT NULL UNIQUE, destinationBaseUrl TEXT,
      requestJson TEXT NOT NULL, requestDigest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attemptCount INTEGER NOT NULL DEFAULT 0, nextAttemptAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      leasedUntil DATETIME, httpStatus INTEGER, responseJson TEXT, errorCode TEXT, errorMessage TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (evaluationId) REFERENCES BenchmarkEvaluation(id) ON DELETE CASCADE
    );
    CREATE TABLE BenchmarkEvaluationArtifact (
      id TEXT PRIMARY KEY, evaluationId TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      mediaType TEXT NOT NULL, sha256 TEXT NOT NULL, sizeBytes INTEGER NOT NULL, storagePath TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (evaluationId) REFERENCES BenchmarkEvaluation(id) ON DELETE CASCADE,
      UNIQUE (evaluationId, name)
    );
    CREATE TABLE ExperimentEvalResult (
      id TEXT PRIMARY KEY, experimentId TEXT NOT NULL, caseId TEXT NOT NULL, evaluatorId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', verdict TEXT, summary TEXT, score REAL, pointsJson TEXT,
      evidenceJson TEXT, humanScore REAL, humanReason TEXT, humanBy TEXT, humanAt DATETIME,
      errorMessage TEXT, attempts INTEGER NOT NULL DEFAULT 0, durationMs INTEGER,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caseId) REFERENCES ExperimentCase(id) ON DELETE CASCADE,
      UNIQUE (caseId, evaluatorId)
    );
    `)
    database.close()
  }
  const [
    storage, artifact, artifactContent, progress, complete,
    evaluationProgress, evaluationArtifact, evaluationComplete,
    evaluationArtifactContent, benchmarkExperimentResult,
    createExperiment, runExperiment, dataset, scheduler,
  ] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/app/api/benchmark/v1/artifacts/route'),
    import('@/app/api/benchmark/v1/artifacts/[artifactId]/content/route'),
    import('@/app/api/benchmark/v1/runs/[runId]/progress/route'),
    import('@/app/api/benchmark/v1/runs/[runId]/complete/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/progress/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/complete/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/[artifactId]/content/route'),
    import('@/app/api/benchmark/v1/experiments/[experimentId]/route'),
    import('@/app/api/experiments/route'),
    import('@/app/api/experiments/[id]/run/route'),
    import('../benchmarks/swe-bench/dataset'),
    import('@/lib/benchmark/scheduler'),
  ])
  prisma = storage.prisma
  artifactRoute = artifact.POST
  artifactContentRoute = artifactContent.GET
  progressRoute = progress.POST
  completeRoute = complete.POST
  evaluationProgressRoute = evaluationProgress.POST
  evaluationArtifactRoute = evaluationArtifact.POST
  evaluationCompleteRoute = evaluationComplete.POST
  evaluationArtifactContentRoute = evaluationArtifactContent.GET
  benchmarkExperimentResultRoute = benchmarkExperimentResult.GET
  createExperimentRoute = createExperiment.POST
  runExperimentRoute = runExperiment.POST
  importOfficialDataset = dataset.importOfficialSweBenchVerifiedDataset
  setCommandDispatcher = scheduler.setBenchmarkCommandDispatcherForTest
})

test.after(async () => {
  if (externalDatabasePath && prisma) {
    const users = [...externalTestUsers]
    const clientIds = [...externalTestClientIds]
    const experimentIds = [...externalTestExperimentIds]
    if (experimentIds.length) {
      await prisma.experiment.deleteMany({ where: { id: { in: experimentIds } } })
    }
    if (users.length) {
      await prisma.experiment.deleteMany({ where: { user: { in: users } } })
    }
    if (clientIds.length) {
      await prisma.reliabilityClient.deleteMany({ where: { clientId: { in: clientIds } } })
    }
    if (users.length) {
      await prisma.agentEvalDataset.deleteMany({ where: { user: { in: users } } })
    }
  }
  await prisma?.$disconnect()
  fs.rmSync(testDir, { recursive: true, force: true })
})

async function nodeRequest(req: http.IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  return new Request(`${origin}${req.url}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
  })
}

async function writeNodeResponse(response: Response, res: http.ServerResponse) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function listen(server: http.Server): Promise<{ origin: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function platformServer() {
  let origin = ''
  const server = http.createServer(async (req, res) => {
    try {
      const request = await nodeRequest(req, origin)
      const url = new URL(request.url)
      let response: Response
      if (req.method === 'POST' && url.pathname === '/api/benchmark/v1/artifacts') {
        response = await artifactRoute(request)
      } else if (req.method === 'GET' && /^\/api\/benchmark\/v1\/artifacts\/[^/]+\/content$/.test(url.pathname)) {
        const artifactId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await artifactContentRoute(request, { params: Promise.resolve({ artifactId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/progress$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationProgressRoute(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/artifacts$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationArtifactRoute(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/complete$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationCompleteRoute(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'GET' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/artifacts\/[^/]+\/content$/.test(url.pathname)) {
        const segments = url.pathname.split('/')
        const evaluationId = decodeURIComponent(segments.at(-4) || '')
        const artifactId = decodeURIComponent(segments.at(-2) || '')
        response = await evaluationArtifactContentRoute(request, {
          params: Promise.resolve({ evaluationId, artifactId }),
        })
      } else if (req.method === 'GET' && /^\/api\/benchmark\/v1\/experiments\/[^/]+$/.test(url.pathname)) {
        const experimentId = decodeURIComponent(url.pathname.split('/').at(-1) || '')
        response = await benchmarkExperimentResultRoute(request, { params: Promise.resolve({ experimentId }) })
      } else if (req.method === 'POST' && /\/progress$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await progressRoute(request, { params: Promise.resolve({ runId }) })
      } else if (req.method === 'POST' && /\/complete$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await completeRoute(request, { params: Promise.resolve({ runId }) })
      } else if (req.method === 'POST' && url.pathname === '/api/experiments') {
        response = await createExperimentRoute(request)
      } else if (req.method === 'POST' && /^\/api\/experiments\/[^/]+\/run$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await runExperimentRoute(request, { params: Promise.resolve({ id }) })
      } else {
        response = new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      await writeNodeResponse(response, res)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  return {
    server,
    setOrigin(value: string) { origin = value },
  }
}

type EvaluationDispatchBody = {
  runId: string
  requestDigest: string
  platformBaseUrl: string
  callbackBaseUrl: string
  evaluationJob: {
    artifacts: Array<{ artifactId: string }>
    payload: {
      instance: {
        instance_id: string
        eval_script: string
        FAIL_TO_PASS: string[]
        PASS_TO_PASS: string[]
      }
      prediction: {
        model_patch_artifact_id: string
        model_name_or_path: string
      }
    }
  }
}

function evaluatorServer(token: string, options: { autoComplete?: boolean } = {}) {
  let origin = ''
  const jobs: Array<{ headers: Headers; body: EvaluationDispatchBody }> = []
  const downloadedArtifacts: Buffer[] = []
  const completionResponses: Array<Record<string, unknown>> = []
  const callbackErrors: Error[] = []
  const server = http.createServer(async (req, res) => {
    try {
      const request = await nodeRequest(req, origin)
      const url = new URL(request.url)
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        await writeNodeResponse(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }), res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        await writeNodeResponse(new Response(JSON.stringify({
          status: 'healthy',
          busy: false,
          evaluators: [{ key: 'swe-bench', ready: true }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }), res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/evaluations') {
        const body = await request.json() as EvaluationDispatchBody
        jobs.push({ headers: request.headers, body })
        const artifactId = body.evaluationJob.artifacts[0].artifactId
        const artifactResponse = await fetch(
          `${body.platformBaseUrl}/api/benchmark/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              'x-agent-insight-evaluation-id': String(body.runId),
            },
          },
        )
        assert.equal(artifactResponse.status, 200)
        downloadedArtifacts.push(Buffer.from(await artifactResponse.arrayBuffer()))
        await writeNodeResponse(new Response(JSON.stringify({
          runId: body.runId,
          requestDigest: body.requestDigest,
          status: 'accepted',
        }), { status: 202, headers: { 'content-type': 'application/json' } }), res)
        if (options.autoComplete) {
          setImmediate(() => void (async () => {
            try {
              const callbackHeaders = { authorization: `Bearer ${token}` }
              const progressResponse = await fetch(`${body.callbackBaseUrl}/progress`, {
                method: 'POST',
                headers: { ...callbackHeaders, 'content-type': 'application/json' },
                body: JSON.stringify({
                  kind: 'evaluation',
                  stage: 'running_harness',
                  occurredAt: new Date().toISOString(),
                }),
              })
              assert.equal(progressResponse.status, 200)
              const evidenceIds: string[] = []
              for (const evidence of [
                { name: 'report.json', kind: 'official-report', mediaType: 'application/json', bytes: Buffer.from('{"resolved":false}\n') },
                { name: 'test_output.txt', kind: 'test-output', mediaType: 'text/plain', bytes: Buffer.from('official harness output\n') },
                { name: 'run_instance.log', kind: 'harness-log', mediaType: 'text/plain', bytes: Buffer.from('official harness log\n') },
              ]) {
                const digest = `sha256:${createHash('sha256').update(evidence.bytes).digest('hex')}`
                const form = new FormData()
                form.set('metadata', JSON.stringify({
                  evaluationId: body.runId,
                  name: evidence.name,
                  kind: evidence.kind,
                  mediaType: evidence.mediaType,
                  sha256: digest,
                }))
                form.set('file', new Blob([evidence.bytes], { type: evidence.mediaType }), evidence.name)
                const uploaded = await fetch(`${body.callbackBaseUrl}/artifacts`, {
                  method: 'POST', headers: callbackHeaders, body: form,
                })
                assert.equal(uploaded.status, 201)
                evidenceIds.push(String((await uploaded.json()).artifactId))
              }
              const completionPayload = {
                status: 'completed',
                rawResult: {
                  instanceId: body.evaluationJob.payload.instance.instance_id,
                  resolved: false,
                  patchSuccessfullyApplied: true,
                  failToPass: { passed: 0, total: body.evaluationJob.payload.instance.FAIL_TO_PASS.length },
                  passToPass: {
                    passed: body.evaluationJob.payload.instance.PASS_TO_PASS.length,
                    total: body.evaluationJob.payload.instance.PASS_TO_PASS.length,
                  },
                },
                evidenceArtifactIds: evidenceIds,
                runtimeFacts: { caseImage: 'test@sha256:digest', formalEligible: false },
                cleanup: { status: 'succeeded' },
              }
              const sendCompletion = () => fetch(`${body.callbackBaseUrl}/complete`, {
                method: 'POST',
                headers: { ...callbackHeaders, 'content-type': 'application/json' },
                body: JSON.stringify(completionPayload),
              })
              const completed = await sendCompletion()
              assert.equal(completed.status, 200)
              completionResponses.push(await completed.json() as Record<string, unknown>)
              const repeated = await sendCompletion()
              assert.equal(repeated.status, 200)
              completionResponses.push(await repeated.json() as Record<string, unknown>)
            } catch (error) {
              callbackErrors.push(error as Error)
            }
          })())
        }
        return
      }
      await writeNodeResponse(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }), res)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  return {
    server,
    jobs,
    downloadedArtifacts,
    completionResponses,
    callbackErrors,
    setOrigin(value: string) { origin = value },
  }
}

function git(command: string[], cwd: string): string {
  const result = spawnSync('git', command, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return String(result.stdout || '').trim()
}

async function seedRun(input: {
  runId: string
  clientId: string
  user: string
  task: AgentTaskEnvelope
  deviceCredential: string
  callbackOrigin: string
}) {
  externalTestUsers.add(input.user)
  externalTestClientIds.add(input.clientId)
  const experimentId = `exp_${input.runId}`
  const caseId = input.task.context.caseId
  await prisma.experiment.create({
    data: {
      id: experimentId,
      user: input.user,
      name: input.runId,
      scope: 'benchmark',
      status: 'running',
      agentName: input.task.agentConfig.agent,
    },
  })
  await prisma.experimentCase.create({ data: { id: caseId, experimentId } })
  const agentEvalDatasetId = `aed_${input.runId}`
  const datasetId = `bds_${input.runId}`
  const datasetCaseId = `bdc_${input.runId}`
  const publicPayload = input.task.task.benchmarkPayload
  const privatePayload = {
    goldPatch: '',
    testPatch: '',
    failToPass: ['tests/test_example.py::test_change'],
    passToPass: ['tests/test_example.py::test_existing'],
    evaluation: {
      image: 'swebench/sweb.eval.fixture:latest',
      script: 'pytest -q',
      type: 'pass_and_fail',
      logParser: 'parse_log_pytest',
    },
    metadata: { createdAt: '', difficulty: '' },
  }
  await prisma.agentEvalDataset.create({
    data: { id: agentEvalDatasetId, user: input.user, name: agentEvalDatasetId },
  })
  await prisma.benchmarkDataset.create({
    data: {
      id: datasetId,
      agentEvalDatasetId,
      user: input.user,
      name: datasetId,
      adapterKey: 'swe-bench',
      contentHash: `sha256:${'d'.repeat(64)}`,
      caseCount: 1,
    },
  })
  await prisma.benchmarkDatasetCase.create({
    data: {
      id: datasetCaseId,
      datasetId,
      externalCaseId: String((publicPayload as Record<string, unknown>).instanceId),
      rawCaseJson: '{}',
      publicPayloadJson: canonicalJson(publicPayload),
      privatePayloadJson: canonicalJson(privatePayload),
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      publicFingerprint: `sha256:${'b'.repeat(64)}`,
      privateFingerprint: `sha256:${'c'.repeat(64)}`,
      ordinal: 0,
    },
  })
  await prisma.benchmarkExperimentBinding.create({
    data: {
      experimentId,
      datasetId,
      datasetContentHash: `sha256:${'d'.repeat(64)}`,
      adapterKey: 'swe-bench',
      selectionJson: '{}',
      runConfigJson: canonicalJson(input.task.agentConfig as never),
      schedulerStatus: 'running',
      expectedCaseCount: 1,
      callbackOrigin: input.callbackOrigin,
    },
  })
  await prisma.reliabilityClient.create({
    data: {
      id: `row_${input.clientId}`,
      clientId: input.clientId,
      user: input.user,
      name: input.clientId,
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
    },
  })
  await prisma.reliabilityClientCredential.create({
    data: {
      id: `cred_${input.clientId}`,
      clientId: input.clientId,
      credentialHash: deviceCredentialHash(input.deviceCredential),
    },
  })
  await prisma.benchmarkCaseRun.create({
    data: {
      id: input.runId,
      experimentId,
      experimentCaseId: caseId,
      datasetCaseId,
      ordinal: 0,
      status: 'running_agent',
      adapterKey: 'swe-bench',
      clientId: input.clientId,
      taskEnvelopeJson: canonicalJson(input.task as never),
      publicPayloadJson: canonicalJson(publicPayload),
      privatePayloadJson: canonicalJson(privatePayload),
    },
  })
}

function taskFor(runId: string, caseId: string, revision: string): AgentTaskEnvelope {
  return {
    schemaVersion: 'agent-task/v1',
    benchmark: { key: 'swe-bench' },
    context: { runId, experimentId: `exp_${runId}`, caseId },
    task: {
      instruction: 'Fix the issue.',
      benchmarkPayload: {
        instanceId: 'example__project-1',
        repo: 'example/project',
        baseCommit: revision,
        problemStatement: 'Change the greeting.',
        hintsText: '',
      },
    },
    workspace: {
      provider: 'git',
      repository: 'https://github.com/example/project.git',
      revision,
    },
    policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'client-default' },
    submission: {
      requiredArtifacts: [{
        name: 'model.patch',
        mediaType: 'text/x-diff',
        collector: 'git-patch/v1',
        maxBytes: 10 * 1024 * 1024,
      }],
    },
    agentConfig: { platform: 'opencode', agent: 'build', timeoutSeconds: 60 },
  }
}

async function waitForRun(runId: string, status: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const run = await prisma.benchmarkCaseRun.findUnique({ where: { id: runId } })
    if (run?.status === status) return run
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${runId} did not reach ${status}`)
}

async function waitForEvaluation(runId: string, status: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const evaluation = await prisma.benchmarkEvaluation.findFirst({ where: { caseRunId: runId } })
    if (evaluation?.status === status) return evaluation
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${runId} evaluation did not reach ${status}`)
}

test('Git workspace retries transient fetch failures and falls back to HTTP/1.1', async () => {
  const revision = 'a'.repeat(40)
  const fetchCalls: Array<{ args: string[]; options: Record<string, unknown> }> = []
  const delays: number[] = []
  let initCalls = 0
  const processRunner = async (
    _command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    if (args[0] === 'init') initCalls += 1
    if (args.includes('fetch')) {
      fetchCalls.push({ args, options })
      if (fetchCalls.length < 3) {
        throw new executorModule.BenchmarkExecutorError(
          'WORKSPACE_PREPARE_FAILED',
          'fatal: RPC failed; curl 56 Failure when receiving data from the peer',
        )
      }
    }
    if (args[0] === 'rev-parse') return { stdout: `${revision}\n`, stderr: '' }
    return { stdout: '', stderr: '' }
  }
  const provider = new executorModule.GitWorkspaceProvider(
    path.join(testDir, 'git-retry-workspaces'),
    processRunner,
    {
      fetchTimeoutMs: 45_000,
      random: () => 0,
      sleep: async (delayMs: number) => { delays.push(delayMs) },
    },
  )

  await provider.prepare(
    { repository: 'https://github.com/astropy/astropy.git', revision },
    { runId: `git_retry_${Date.now()}` },
  )

  assert.equal(fetchCalls.length, 3)
  assert.equal(initCalls, 3)
  assert.deepEqual(delays, [1_000, 2_000])
  assert.deepEqual(fetchCalls[0]?.args, ['fetch', '--quiet', '--depth=1', 'origin', revision])
  assert.deepEqual(fetchCalls[2]?.args, [
    '-c', 'http.version=HTTP/1.1', 'fetch', '--quiet', '--depth=1', 'origin', revision,
  ])
  assert.equal(fetchCalls[0]?.options.timeoutMs, 45_000)
  assert.equal(fetchCalls[0]?.options.killProcessGroup, true)
  assert.equal(
    (fetchCalls[0]?.options.env as NodeJS.ProcessEnv | undefined)?.GIT_TERMINAL_PROMPT,
    '0',
  )
})

test('Git workspace does not retry permanent fetch errors', async () => {
  const revision = 'b'.repeat(40)
  let fetchCalls = 0
  const processRunner = async (
    _command: string,
    args: string[],
    _options: Record<string, unknown>,
  ) => {
    if (args.includes('fetch')) {
      fetchCalls += 1
      throw new executorModule.BenchmarkExecutorError(
        'WORKSPACE_PREPARE_FAILED',
        "fatal: couldn't find remote ref missing-revision",
      )
    }
    return { stdout: '', stderr: '' }
  }
  const provider = new executorModule.GitWorkspaceProvider(
    path.join(testDir, 'git-permanent-error-workspaces'),
    processRunner,
  )

  await assert.rejects(
    provider.prepare(
      { repository: 'https://github.com/astropy/astropy.git', revision },
      { runId: `git_permanent_${Date.now()}` },
    ),
    /couldn't find remote ref/,
  )
  assert.equal(fetchCalls, 1)
})

test('Git workspace stops after three transient fetch failures', async () => {
  const revision = 'c'.repeat(40)
  let fetchCalls = 0
  const delays: number[] = []
  const processRunner = async (
    _command: string,
    args: string[],
    _options: Record<string, unknown>,
  ) => {
    if (args.includes('fetch')) {
      fetchCalls += 1
      const error = new executorModule.BenchmarkExecutorError(
        'WORKSPACE_PREPARE_FAILED',
        'fatal: HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR',
      ) as Error & { stderr?: string }
      error.stderr = 'fatal: HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR'
      throw error
    }
    return { stdout: '', stderr: '' }
  }
  const provider = new executorModule.GitWorkspaceProvider(
    path.join(testDir, 'git-exhausted-workspaces'),
    processRunner,
    {
      random: () => 0,
      sleep: async (delayMs: number) => { delays.push(delayMs) },
    },
  )

  await assert.rejects(
    provider.prepare(
      { repository: 'https://github.com/astropy/astropy.git', revision },
      { runId: `git_exhausted_${Date.now()}` },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WORKSPACE_PREPARE_FAILED')
      assert.equal((error as { retryable?: boolean }).retryable, true)
      assert.match((error as Error).message, /3 次尝试均失败/)
      assert.match((error as Error).message, /PROTOCOL_ERROR/)
      return true
    },
  )
  assert.equal(fetchCalls, 3)
  assert.deepEqual(delays, [1_000, 2_000])
})

test('process runner terminates a command after its deadline', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    executorModule.runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 50, timeoutErrorCode: 'PROCESS_TIMEOUT' },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROCESS_TIMEOUT')
      assert.equal((error as { retryable?: boolean }).retryable, true)
      return true
    },
  )
  assert.ok(Date.now() - startedAt < 2_000)
})

test('Git patch collector reports an empty submission as AGENT_NO_OUTPUT', async () => {
  const collector = new executorModule.GitPatchCollector(async () => ({ stdout: '', stderr: '' }))

  await assert.rejects(
    collector.collect(
      { name: 'model.patch', mediaType: 'text/x-diff', maxBytes: 1024 },
      { workspace: { path: testDir, baseCommit: 'a'.repeat(40) } },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'AGENT_NO_OUTPUT')
      return true
    },
  )
})

test('Benchmark failure completion preserves Agent run facts', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const runId = `erun_agent_failure_${suffix}`
  const baseDir = path.join(testDir, `agent-failure-${suffix}`)
  const insightBaseUrl = 'http://127.0.0.1:43202'
  let completion: Record<string, any> | null = null
  let resolveCompletion!: () => void
  const completionGate = new Promise<void>((resolve) => { resolveCompletion = resolve })
  const executor = executorModule.createBenchmarkExecutor({
    clientId: `agent_failure_client_${suffix}`,
    deviceCredential: `dc_agent_failure_${suffix}`,
    insightBaseUrl,
    baseDir,
    callback: {
      async progress() {},
      async uploadArtifact() {
        throw new Error('artifact upload must not run after Agent failure')
      },
      async complete(_request: unknown, body: Record<string, any>) {
        completion = body
        resolveCompletion()
      },
    },
    workspaceProvider: {
      rootDir: path.join(baseDir, 'workspaces', 'benchmark'),
      async prepare(spec: { revision: string }, context: { runId: string }) {
        const workspace = path.join(baseDir, 'workspaces', 'benchmark', context.runId)
        await fsp.mkdir(workspace, { recursive: true })
        return { path: workspace, baseCommit: spec.revision }
      },
    },
    async runAgent() {
      const error = new executorModule.BenchmarkExecutorError(
        'AGENT_TIMEOUT',
        'Agent execution timed out',
      ) as Error & {
        runFacts?: { traceId: string; exitCode: number | null; timedOut: boolean }
      }
      error.runFacts = {
        traceId: 'ses_timed_out_agent',
        exitCode: null,
        timedOut: true,
      }
      throw error
    },
  })
  const task = taskFor(runId, `case_${runId}`, 'e'.repeat(40))
  const requestBody = {
    runId,
    task,
    callbackBaseUrl: `${insightBaseUrl}/api/benchmark/v1/runs/${runId}`,
    timeoutSeconds: 60,
  }
  const request = { ...requestBody, requestDigest: benchmarkDispatchDigest(requestBody) }

  try {
    await executor.accept(request)
    await Promise.race([
      completionGate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('failure completion timed out')), 5_000)),
    ])
    assert.equal(completion?.status, 'failed')
    assert.equal(completion?.error?.code, 'AGENT_TIMEOUT')
    assert.equal(completion?.runFacts?.traceId, 'ses_timed_out_agent')
    assert.equal(completion?.runFacts?.timedOut, true)
    assert.equal(completion?.runFacts?.platform, 'opencode')
    assert.equal(completion?.runFacts?.agent, 'build')
  } finally {
    await executor.close()
  }
})

test('failed Benchmark completion durably settles the Case before acknowledging and stays idempotent', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const runId = `erun_failed_completion_${suffix}`
  const clientId = `client_failed_completion_${suffix}`
  const user = `user_failed_completion_${suffix}`
  const deviceCredential = `dc_failed_completion_${suffix}`
  const caseId = `case_${runId}`
  const task = taskFor(runId, caseId, 'f'.repeat(40))
  await seedRun({
    runId,
    clientId,
    user,
    task,
    deviceCredential,
    callbackOrigin: 'http://127.0.0.1:3000',
  })
  await prisma.experimentEvalResult.create({
    data: {
      experimentId: `exp_${runId}`,
      caseId,
      evaluatorId: 'benchmark:swe-bench',
      status: 'pending',
    },
  })
  const completion = {
    kind: 'execution',
    status: 'failed',
    artifacts: [],
    runFacts: { traceId: `ses_${runId}`, exitCode: 1 },
    cleanup: { status: 'succeeded' },
    error: { code: 'MODEL_UNAVAILABLE', message: '模型配置无效' },
  }
  const invoke = () => completeRoute(new Request(
    `http://localhost/api/benchmark/v1/runs/${runId}/complete`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deviceCredential}`,
        'content-type': 'application/json',
        'x-agent-insight-client-id': clientId,
      },
      body: JSON.stringify(completion),
    },
  ), { params: Promise.resolve({ runId }) })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await invoke()
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'execution_failed')
    const [run, result, experiment] = await Promise.all([
      prisma.benchmarkCaseRun.findUnique({ where: { id: runId } }),
      prisma.experimentEvalResult.findUnique({
        where: { caseId_evaluatorId: { caseId, evaluatorId: 'benchmark:swe-bench' } },
      }),
      prisma.experiment.findUnique({ where: { id: `exp_${runId}` } }),
    ])
    assert.equal(run?.failureCode, 'MODEL_UNAVAILABLE')
    assert.equal(result?.status, 'failed')
    assert.equal(experiment?.status, 'failed')
  }
})

test('steps 04-09 cross real HTTP APIs, validate and dispatch a Git patch idempotently', async () => {
  const runId = `erun_api_${Date.now()}`
  const clientId = `client_api_${Date.now()}`
  const user = `user_api_${Date.now()}`
  const deviceCredential = 'dc_executor_api_test'
  const sourceRepo = path.join(testDir, `source-${runId}`)
  fs.mkdirSync(sourceRepo, { recursive: true })
  git(['init', '--quiet'], sourceRepo)
  git(['config', 'user.email', 'test@example.com'], sourceRepo)
  git(['config', 'user.name', 'Agent Insight Test'], sourceRepo)
  fs.writeFileSync(path.join(sourceRepo, 'greeting.txt'), 'hello\n')
  git(['add', '-A'], sourceRepo)
  git(['commit', '--quiet', '-m', 'base'], sourceRepo)
  const revision = git(['rev-parse', 'HEAD'], sourceRepo)

  const platform = platformServer()
  const platformListener = await listen(platform.server)
  platform.setOrigin(platformListener.origin)
  const evaluatorToken = `evaluator_${runId}`
  const evaluator = evaluatorServer(evaluatorToken)
  const evaluatorListener = await listen(evaluator.server)
  evaluator.setOrigin(evaluatorListener.origin)
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL = evaluatorListener.origin
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN = evaluatorToken
  const executorBaseDir = path.join(testDir, `executor-${runId}`)
  let workspacePath = ''
  let agentRuns = 0
  const executor = executorModule.createBenchmarkExecutor({
    clientId,
    deviceCredential,
    insightBaseUrl: platformListener.origin,
    baseDir: executorBaseDir,
    workspaceProvider: {
      rootDir: path.join(executorBaseDir, 'workspaces', 'benchmark'),
      async prepare(_spec: unknown, context: { runId: string }) {
        workspacePath = path.join(executorBaseDir, 'workspaces', 'benchmark', context.runId)
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true })
        git(['clone', '--quiet', sourceRepo, workspacePath], testDir)
        git(['checkout', '--quiet', '--detach', revision], workspacePath)
        return { path: workspacePath, baseCommit: revision }
      },
    },
    async runAgent(input: { cwd: string }) {
      agentRuns += 1
      await fsp.writeFile(path.join(input.cwd, 'greeting.txt'), 'hello benchmark\n')
      await fsp.writeFile(path.join(input.cwd, 'model.patch'), 'agent-created artifact must be excluded\n')
      return {
        platform: 'opencode',
        agent: 'build',
        traceId: 'trace_api_1',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
    },
  })
  const executorAddress = await executor.listen('127.0.0.1', 0)
  const executorOrigin = `http://127.0.0.1:${executorAddress.port}`
  const caseId = `case_${runId}`
  const task = taskFor(runId, caseId, revision)
  await seedRun({
    runId,
    clientId,
    user,
    task,
    deviceCredential,
    callbackOrigin: platformListener.origin,
  })
  const callbackBaseUrl = `${platformListener.origin}/api/benchmark/v1/runs/${runId}`
  const requestBody = { runId, task, callbackBaseUrl, timeoutSeconds: 60 }
  const requestDigest = benchmarkDispatchDigest(requestBody)
  const request = { ...requestBody, requestDigest }
  const token = createBenchmarkDispatchToken({
    clientId,
    runId,
    requestDigest,
    credentialHash: deviceCredentialHash(deviceCredential),
  })
  const dispatch = () => fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': runId,
      'x-agent-insight-request-digest': requestDigest,
    },
    body: JSON.stringify(request),
  })
  try {
    const unauthorizedToken = createBenchmarkDispatchToken({
      clientId,
      runId,
      requestDigest,
      credentialHash: deviceCredentialHash('wrong-device-credential'),
    })
    const unauthorized = await fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${unauthorizedToken}`,
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-agent-insight-request-digest': requestDigest,
      },
      body: JSON.stringify(request),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'DISPATCH_UNAUTHORIZED')

    const unsupportedBody = {
      ...requestBody,
      task: { ...task, agentConfig: { ...task.agentConfig, platform: 'xiaoo' } },
    }
    const unsupportedDigest = benchmarkDispatchDigest(unsupportedBody)
    const unsupportedToken = createBenchmarkDispatchToken({
      clientId,
      runId,
      requestDigest: unsupportedDigest,
      credentialHash: deviceCredentialHash(deviceCredential),
    })
    const unsupported = await fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${unsupportedToken}`,
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-agent-insight-request-digest': unsupportedDigest,
      },
      body: JSON.stringify({ ...unsupportedBody, requestDigest: unsupportedDigest }),
    })
    assert.equal(unsupported.status, 422)
    assert.equal((await unsupported.json()).error.code, 'EXECUTOR_CAPABILITY_MISSING')

    const response = await dispatch()
    assert.equal(response.status, 202)
    assert.equal((await response.json()).requestDigest, requestDigest)
    const completed = await waitForRun(runId, 'submitted')
    assert.equal(JSON.parse(completed.runFactsJson || '{}').traceId, 'trace_api_1')
    assert.equal(JSON.parse(completed.cleanupJson || '{}').status, 'succeeded')
    const artifact = await prisma.benchmarkArtifact.findFirst({ where: { runId } })
    assert.ok(artifact)
    const artifactBytes = fs.readFileSync(path.join(process.env.AGENT_INSIGHT_DATA_DIR!, 'data', artifact.storagePath))
    assert.match(artifactBytes.toString('utf8'), /hello benchmark/)
    assert.doesNotMatch(artifactBytes.toString('utf8'), /diff --git a\/model\.patch/)
    assert.equal(fs.existsSync(workspacePath), false)
    const evaluation = await waitForEvaluation(runId, 'running_evaluator')
    assert.equal(evaluator.jobs.length, 1)
    assert.equal(evaluator.jobs[0].body.runId, evaluation.id)
    assert.equal(evaluator.jobs[0].body.evaluationJob.payload.prediction.model_patch_artifact_id, artifact.id)
    assert.equal(JSON.stringify(evaluator.jobs[0].body).includes('goldPatch'), false)
    assert.deepEqual(evaluator.downloadedArtifacts, [artifactBytes])
    assert.equal(evaluator.jobs[0].headers.get('idempotency-key'), evaluation.id)
    assert.equal(
      evaluator.jobs[0].headers.get('x-agent-insight-request-digest'),
      evaluator.jobs[0].body.requestDigest,
    )
    const unauthorizedArtifact = await fetch(
      `${platformListener.origin}/api/benchmark/v1/artifacts/${artifact.id}/content`,
      { headers: { 'x-agent-insight-evaluation-id': evaluation.id } },
    )
    assert.equal(unauthorizedArtifact.status, 401)

    assert.equal((await dispatch()).status, 202)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(agentRuns, 1)

    const conflictingBody = {
      ...requestBody,
      task: { ...task, task: { ...task.task, instruction: 'Different instruction.' } },
    }
    const conflictingDigest = benchmarkDispatchDigest(conflictingBody)
    const conflictingToken = createBenchmarkDispatchToken({
      clientId,
      runId,
      requestDigest: conflictingDigest,
      credentialHash: deviceCredentialHash(deviceCredential),
    })
    const conflict = await fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conflictingToken}`,
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-agent-insight-request-digest': conflictingDigest,
      },
      body: JSON.stringify({ ...conflictingBody, requestDigest: conflictingDigest }),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'RUN_ID_CONFLICT')
  } finally {
    await executor.close()
    await evaluatorListener.close()
    await platformListener.close()
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN
  }
})

test('step 04 exposes authenticated health and returns retryable SERVICE_BUSY', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const clientId = `busy_client_${suffix}`
  const deviceCredential = `dc_busy_${suffix}`
  const insightBaseUrl = 'http://127.0.0.1:43199'
  const baseDir = path.join(testDir, `busy-executor-${suffix}`)
  let unblockAgent!: () => void
  const agentGate = new Promise<void>((resolve) => { unblockAgent = resolve })
  const executor = executorModule.createBenchmarkExecutor({
    clientId,
    deviceCredential,
    insightBaseUrl,
    baseDir,
    callback: {
      async progress() {},
      async uploadArtifact(_request: unknown, artifact: { name: string; sha256: string }) {
        return { artifactId: 'bart_busy', name: artifact.name, sha256: artifact.sha256 }
      },
      async complete() {},
    },
    workspaceProvider: {
      rootDir: path.join(baseDir, 'workspaces', 'benchmark'),
      async prepare(spec: { revision: string }, context: { runId: string }) {
        const workspace = path.join(baseDir, 'workspaces', 'benchmark', context.runId)
        await fsp.mkdir(workspace, { recursive: true })
        return { path: workspace, baseCommit: spec.revision }
      },
    },
    collectors: new Map([['git-patch/v1', {
      async collect(contract: { name: string; mediaType: string }) {
        const bytes = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n')
        return {
          name: contract.name,
          mediaType: contract.mediaType,
          bytes,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }
      },
    }]]),
    async runAgent() {
      await agentGate
      return { traceId: 'trace_busy', exitCode: 0 }
    },
  })
  const address = await executor.listen('127.0.0.1', 0)
  const executorOrigin = `http://127.0.0.1:${address.port}`
  const dispatch = async (runId: string) => {
    const task = taskFor(runId, `case_${runId}`, 'b'.repeat(40))
    const requestBody = {
      runId,
      task,
      callbackBaseUrl: `${insightBaseUrl}/api/benchmark/v1/runs/${runId}`,
      timeoutSeconds: 60,
    }
    const requestDigest = benchmarkDispatchDigest(requestBody)
    const token = createBenchmarkDispatchToken({
      clientId,
      runId,
      requestDigest,
      credentialHash: deviceCredentialHash(deviceCredential),
    })
    return fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-agent-insight-request-digest': requestDigest,
      },
      body: JSON.stringify({ ...requestBody, requestDigest }),
    })
  }
  try {
    assert.equal((await dispatch(`erun_busy_1_${suffix}`)).status, 202)
    const healthToken = createBenchmarkHealthToken({
      clientId,
      credentialHash: deviceCredentialHash(deviceCredential),
    })
    const health = await fetch(`${executorOrigin}/health`, {
      headers: { authorization: `Bearer ${healthToken}` },
    })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).busy, true)

    const busy = await dispatch(`erun_busy_2_${suffix}`)
    assert.equal(busy.status, 409)
    const busyBody = await busy.json()
    assert.equal(busyBody.error.code, 'SERVICE_BUSY')
    assert.equal(busyBody.error.retryable, true)
  } finally {
    unblockAgent()
    const deadline = Date.now() + 5_000
    while (executor.activeRunId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await executor.close()
  }
})

test('executor advertises every configured trace-safe Agent Runtime', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const clientId = `runtime_client_${suffix}`
  const deviceCredential = `dc_runtime_${suffix}`
  const executor = executorModule.createBenchmarkExecutor({
    clientId,
    deviceCredential,
    insightBaseUrl: 'http://127.0.0.1:43199',
    baseDir: path.join(testDir, `runtime-executor-${suffix}`),
    agentPlatforms: ['opencode', 'codex', 'codex'],
    async runAgent() {
      return { traceId: 'trace_runtime', exitCode: 0 }
    },
  })
  const address = await executor.listen('127.0.0.1', 0)
  try {
    const healthToken = createBenchmarkHealthToken({
      clientId,
      credentialHash: deviceCredentialHash(deviceCredential),
    })
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { authorization: `Bearer ${healthToken}` },
    })
    assert.equal(response.status, 200)
    const health = await response.json() as { capabilities: string[] }
    assert.deepEqual(
      health.capabilities.filter(capability => capability.startsWith('agent-runtime/')),
      ['agent-runtime/opencode/v1', 'agent-runtime/codex/v1'],
    )
  } finally {
    await executor.close()
  }
})

test('step 07 retries the same successful completion without rerunning Agent', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const runId = `erun_complete_retry_${suffix}`
  const clientId = `complete_retry_client_${suffix}`
  const deviceCredential = `dc_complete_retry_${suffix}`
  const insightBaseUrl = 'http://127.0.0.1:43200'
  const baseDir = path.join(testDir, `complete-retry-${suffix}`)
  const completions: Array<{ status: string }> = []
  let agentRuns = 0
  const executor = executorModule.createBenchmarkExecutor({
    clientId,
    deviceCredential,
    insightBaseUrl,
    baseDir,
    callback: {
      async progress() {},
      async uploadArtifact(_request: unknown, artifact: { name: string; sha256: string }) {
        return { artifactId: 'bart_complete_retry', name: artifact.name, sha256: artifact.sha256 }
      },
      async complete(_request: unknown, completion: { status: string }) {
        completions.push(completion)
        if (completions.length === 1) throw new Error('synthetic callback disconnect')
      },
    },
    workspaceProvider: {
      rootDir: path.join(baseDir, 'workspaces', 'benchmark'),
      async prepare(spec: { revision: string }, context: { runId: string }) {
        const workspace = path.join(baseDir, 'workspaces', 'benchmark', context.runId)
        await fsp.mkdir(workspace, { recursive: true })
        return { path: workspace, baseCommit: spec.revision }
      },
    },
    collectors: new Map([['git-patch/v1', {
      async collect(contract: { name: string; mediaType: string }) {
        const bytes = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n')
        return {
          name: contract.name,
          mediaType: contract.mediaType,
          bytes,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }
      },
    }]]),
    async runAgent() {
      agentRuns += 1
      return { traceId: 'trace_complete_retry', exitCode: 0 }
    },
  })
  const address = await executor.listen('127.0.0.1', 0)
  const executorOrigin = `http://127.0.0.1:${address.port}`
  const task = taskFor(runId, `case_${runId}`, 'c'.repeat(40))
  const requestBody = {
    runId,
    task,
    callbackBaseUrl: `${insightBaseUrl}/api/benchmark/v1/runs/${runId}`,
    timeoutSeconds: 60,
  }
  const requestDigest = benchmarkDispatchDigest(requestBody)
  const token = createBenchmarkDispatchToken({
    clientId,
    runId,
    requestDigest,
    credentialHash: deviceCredentialHash(deviceCredential),
  })
  try {
    const accepted = await fetch(`${executorOrigin}/api/v1/benchmark-executions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-agent-insight-request-digest': requestDigest,
      },
      body: JSON.stringify({ ...requestBody, requestDigest }),
    })
    assert.equal(accepted.status, 202)
    const firstDeadline = Date.now() + 5_000
    while (executor.activeRunId && Date.now() < firstDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pending = await executor.store.state(runId)
    assert.equal(pending?.stage, 'complete_pending')
    assert.equal((pending?.completion as { status: string }).status, 'succeeded')

    await executor.recover()
    const retryDeadline = Date.now() + 5_000
    while ((await executor.store.state(runId))?.stage !== 'terminal' && Date.now() < retryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(agentRuns, 1)
    assert.deepEqual(completions.map((item) => item.status), ['succeeded', 'succeeded'])
    assert.equal((await executor.store.state(runId))?.stage, 'terminal')
  } finally {
    await executor.close()
  }
})

test('completion retry does not occupy the Agent execution slot and backs off after failure', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const firstRunId = `erun_delivery_1_${suffix}`
  const secondRunId = `erun_delivery_2_${suffix}`
  const baseDir = path.join(testDir, `delivery-lane-${suffix}`)
  let releaseRetry!: () => void
  let retryStarted!: () => void
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
  const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve })
  const completionCalls = new Map<string, number>()
  const agentRuns: string[] = []
  const executor = executorModule.createBenchmarkExecutor({
    clientId: `delivery_client_${suffix}`,
    deviceCredential: `dc_delivery_${suffix}`,
    insightBaseUrl: 'http://127.0.0.1:43201',
    baseDir,
    callback: {
      async progress() {},
      async uploadArtifact(_request: unknown, artifact: { name: string; sha256: string }) {
        return { artifactId: `bart_${Date.now()}`, name: artifact.name, sha256: artifact.sha256 }
      },
      async complete(request: { runId: string }) {
        const count = (completionCalls.get(request.runId) || 0) + 1
        completionCalls.set(request.runId, count)
        if (request.runId === firstRunId) {
          if (count === 1) throw new Error('synthetic initial callback failure')
          retryStarted()
          await retryGate
          throw new Error('synthetic retry callback failure')
        }
      },
    },
    workspaceProvider: {
      rootDir: path.join(baseDir, 'workspaces', 'benchmark'),
      async prepare(spec: { revision: string }, context: { runId: string }) {
        const workspace = path.join(baseDir, 'workspaces', 'benchmark', context.runId)
        await fsp.mkdir(workspace, { recursive: true })
        return { path: workspace, baseCommit: spec.revision }
      },
    },
    collectors: new Map([['git-patch/v1', {
      async collect(contract: { name: string; mediaType: string }) {
        const bytes = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n')
        return {
          name: contract.name,
          mediaType: contract.mediaType,
          bytes,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }
      },
    }]]),
    async runAgent(payload: { correlation: { caseRunId: string } }) {
      agentRuns.push(payload.correlation.caseRunId)
      return { traceId: `trace_${payload.correlation.caseRunId}`, exitCode: 0 }
    },
  })
  const requestFor = (runId: string) => {
    const request = {
      runId,
      task: taskFor(runId, `case_${runId}`, 'd'.repeat(40)),
      callbackBaseUrl: `http://127.0.0.1:43201/api/benchmark/v1/runs/${runId}`,
      timeoutSeconds: 60,
    }
    return { ...request, requestDigest: benchmarkDispatchDigest(request) }
  }
  try {
    await executor.accept(requestFor(firstRunId))
    const pendingDeadline = Date.now() + 5_000
    while ((await executor.store.state(firstRunId))?.stage !== 'complete_pending' && Date.now() < pendingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await executor.store.state(firstRunId))?.stage, 'complete_pending')
    while (executor.activeRunId && Date.now() < pendingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(executor.activeRunId, null)

    await executor.recover()
    await retryStartedGate
    assert.equal(executor.activeRunId, null)

    await executor.accept(requestFor(secondRunId))
    const secondDeadline = Date.now() + 5_000
    while ((await executor.store.state(secondRunId))?.stage !== 'terminal' && Date.now() < secondDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await executor.store.state(secondRunId))?.stage, 'terminal')
    assert.deepEqual(agentRuns, [firstRunId, secondRunId])

    releaseRetry()
    const backoffDeadline = Date.now() + 5_000
    while (!(await executor.store.state(firstRunId))?.nextDeliveryRetryAt && Date.now() < backoffDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pending = await executor.store.state(firstRunId)
    assert.equal(pending?.stage, 'complete_pending')
    assert.equal(pending?.deliveryRetryCount, 1)
    assert.ok(Date.parse(String(pending?.nextDeliveryRetryAt)) > Date.now())
  } finally {
    releaseRetry()
    await executor.close()
  }
})

const datasetPath = process.env.SWE_BENCH_DATASET_PATH
  || path.join(os.homedir(), '.agent-insight', 'data', 'imports', 'swe-bench-verified', 'test.parquet')
const pythonPath = process.env.SWE_BENCH_PYTHON
  || path.join(os.homedir(), '.agent-insight', 'vendor', 'SWE-bench', '.venv', 'bin', 'python')
const officialMissing = [datasetPath, pythonPath].find((item) => !fs.existsSync(item))

test('steps 01-13 cross the client-command and evaluator boundaries with a real SWE-bench Case', {
  skip: officialMissing ? `missing external prerequisite: ${officialMissing}` : false,
  timeout: 180_000,
}, async () => {
  const suffix = `${Date.now()}_${process.pid}`
  let user = `full_flow_${suffix}`
  const clientId = `full_client_${suffix}`
  if (!externalDatabasePath) externalTestUsers.add(user)
  externalTestClientIds.add(clientId)
  const deviceCredential = `dc_full_${suffix}`
  const platform = platformServer()
  const platformListener = await listen(platform.server)
  platform.setOrigin(platformListener.origin)
  const evaluatorToken = `full_evaluator_${suffix}`
  const evaluator = evaluatorServer(evaluatorToken, { autoComplete: true })
  const evaluatorListener = await listen(evaluator.server)
  evaluator.setOrigin(evaluatorListener.origin)
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL = evaluatorListener.origin
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN = evaluatorToken
  const executorBaseDir = path.join(testDir, `full-executor-${suffix}`)
  let agentRuns = 0
  const patchBytes = Buffer.from('diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n')
  const executor = executorModule.createBenchmarkExecutor({
    clientId,
    deviceCredential,
    insightBaseUrl: platformListener.origin,
    baseDir: executorBaseDir,
    workspaceProvider: {
      rootDir: path.join(executorBaseDir, 'workspaces', 'benchmark'),
      async prepare(spec: { revision: string }, context: { runId: string }) {
        const workspace = path.join(executorBaseDir, 'workspaces', 'benchmark', context.runId)
        await fsp.mkdir(workspace, { recursive: true })
        return { path: workspace, baseCommit: spec.revision }
      },
    },
    collectors: new Map([['git-patch/v1', {
      async collect(contract: { name: string; mediaType: string }) {
        return {
          name: contract.name,
          mediaType: contract.mediaType,
          bytes: patchBytes,
          sha256: `sha256:${createHash('sha256').update(patchBytes).digest('hex')}`,
        }
      },
    }]]),
    async runAgent(input: { cwd: string }) {
      agentRuns += 1
      await fsp.writeFile(path.join(input.cwd, 'agent-ran.txt'), 'ok')
      return {
        platform: 'opencode',
        agent: 'build',
        traceId: `trace_full_${suffix}`,
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
    },
  })
  try {
    const imported = externalDatabasePath
      ? await prisma.benchmarkDataset.findFirst({
          where: { adapterKey: 'swe-bench', status: 'ready', caseCount: 500 },
          orderBy: { createdAt: 'asc' },
        })
      : await importOfficialDataset({
          user,
          name: `SWE-bench Verified full flow ${suffix}`,
          datasetPath,
          pythonPath,
        })
    assert.ok(imported)
    assert.equal(imported.caseCount, 500)
    if (externalDatabasePath) user = imported.user
    const firstCase = await prisma.benchmarkDatasetCase.findFirst({
      where: { datasetId: imported.id },
      orderBy: { ordinal: 'asc' },
    })
    assert.ok(firstCase)
    await prisma.reliabilityClient.create({
      data: {
        id: `row_${clientId}`,
        clientId,
        user,
        name: 'full flow executor',
        status: 'online',
        serviceHealth: 'healthy',
        lastSeenAt: new Date(),
        capabilitiesJson: JSON.stringify({
          platforms: [{
            id: 'opencode',
            agents: ['build'],
            runExperimentCase: { version: 2, returnsTraceId: true },
            actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
          }],
          components: {
            'git-workspace/v1': { ready: true },
            'agent-runtime/opencode/v1': { ready: true },
            'git-patch/v1': { ready: true },
          },
        }),
      },
    })
    await prisma.reliabilityClientCredential.create({
      data: {
        id: `cred_${clientId}`,
        clientId,
        credentialHash: deviceCredentialHash(deviceCredential),
      },
    })
    setCommandDispatcher(async (input) => ({
      commandId: `cmd_full_${suffix}`,
      status: 'accepted',
      receipt: await executor.accept(input.request),
    }))
    const createResponse = await fetch(`${platformListener.origin}/api/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user,
        scope: 'benchmark',
        name: 'SWE-bench 01-13 API flow',
        agentName: 'build',
        benchmark: {
          datasetId: imported.id,
          caseSelection: { mode: 'explicit', caseIds: [firstCase.id] },
          executionTarget: { clientId },
          runConfig: {
            platform: 'opencode',
            agent: 'build',
            model: 'configured-default',
            agentTimeoutSeconds: 60,
            maxParallelAgentCases: 1,
          },
        },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json() as { id: string; caseCount: number }
    if (externalDatabasePath) externalTestExperimentIds.add(created.id)
    assert.equal(created.caseCount, 1)
    const runResponse = await fetch(
      `${platformListener.origin}/api/experiments/${created.id}/run?user=${encodeURIComponent(user)}`,
      { method: 'POST' },
    )
    assert.equal(runResponse.status, 202)
    const started = await runResponse.json() as { runId: string }
    const completed = await waitForRun(started.runId, 'submitted')
    assert.equal(agentRuns, 1)
    assert.equal(completed.failureCode, null)
    assert.equal(JSON.parse(completed.runFactsJson || '{}').traceId, `trace_full_${suffix}`)
    const task = JSON.parse(completed.taskEnvelopeJson || '{}')
    assert.equal(task.task.benchmarkPayload.instanceId, firstCase.externalCaseId)
    assert.equal(JSON.stringify(task).includes('FAIL_TO_PASS'), false)
    assert.equal(await prisma.benchmarkArtifact.count({ where: { runId: started.runId } }), 1)
    const outbox = await prisma.benchmarkDispatchOutbox.findUnique({ where: { runId: started.runId } })
    assert.equal(outbox?.status, 'accepted')
    const evaluation = await waitForEvaluation(started.runId, 'completed')
    assert.equal(evaluator.jobs.length, 1)
    const evaluationJob = evaluator.jobs[0].body.evaluationJob
    assert.equal(evaluationJob.payload.instance.instance_id, firstCase.externalCaseId)
    assert.ok(evaluationJob.payload.instance.eval_script)
    assert.ok(evaluationJob.payload.instance.FAIL_TO_PASS.length > 0)
    assert.equal(evaluationJob.payload.prediction.model_name_or_path, 'configured-default')
    assert.equal(JSON.stringify(evaluationJob).includes('goldPatch'), false)
    assert.equal(JSON.stringify(evaluationJob).includes('testPatch'), false)
    assert.equal(evaluator.downloadedArtifacts.length, 1)
    assert.match(evaluator.downloadedArtifacts[0].toString('utf8'), /^diff --git /)
    const evaluationOutbox = await prisma.benchmarkEvaluationDispatchOutbox.findUnique({
      where: { evaluationId: evaluation.id },
    })
    assert.equal(evaluationOutbox?.status, 'accepted')
    const completionDeadline = Date.now() + 15_000
    while (
      evaluator.completionResponses.length < 2
      && evaluator.callbackErrors.length === 0
      && Date.now() < completionDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(evaluator.callbackErrors.length, 0)
    assert.equal(evaluator.completionResponses.length, 2)
    assert.deepEqual(evaluator.completionResponses[1], evaluator.completionResponses[0])
    assert.ok(evaluation.rawResultJson)
    assert.ok(evaluation.normalizedResultJson)
    assert.equal(await prisma.benchmarkEvaluationArtifact.count({
      where: { evaluationId: evaluation.id },
    }), 3)
    const normalized = JSON.parse(evaluation.normalizedResultJson || '{}')
    assert.equal(normalized.status, 'done')
    assert.equal(normalized.verdict, 'fail')
    assert.equal(normalized.score, 0)
    const experimentResult = await prisma.experimentEvalResult.findUnique({
      where: {
        caseId_evaluatorId: {
          caseId: completed.experimentCaseId,
          evaluatorId: 'benchmark:swe-bench',
        },
      },
    })
    assert.equal(experimentResult?.status, 'done')
    assert.equal(experimentResult?.verdict, 'fail')
    assert.equal(experimentResult?.score, 0)
    const resultResponse = await fetch(
      `${platformListener.origin}/api/benchmark/v1/experiments/${created.id}?user=${encodeURIComponent(user)}`,
    )
    assert.equal(resultResponse.status, 200)
    const resultBody = await resultResponse.json() as Record<string, any>
    assert.equal(resultBody.status, 'completed')
    assert.deepEqual(resultBody.progress, {
      total: 1,
      completed: 1,
      pending: 0,
      coverageRate: 100,
    })
    assert.deepEqual(resultBody.outcomes, { pass: 0, warn: 0, fail: 1, unknown: 0 })
    assert.deepEqual(resultBody.metrics.primary, {
      key: 'resolvedRate', value: 0, numerator: 0, denominator: 1,
    })
    assert.equal(resultBody.cases[0].externalCaseId, firstCase.externalCaseId)
    assert.equal(resultBody.cases[0].execution.traceId, `trace_full_${suffix}`)
    assert.equal(resultBody.cases[0].nativeMetrics.officialReport, undefined)
    const serializedResult = JSON.stringify(resultBody)
    for (const hidden of ['goldPatch', 'testPatch', 'eval_script', 'storagePath', 'privatePayloadJson', 'requestJson']) {
      assert.equal(serializedResult.includes(hidden), false)
    }
    const evidence = resultBody.cases[0].evidence[0]
    const evidenceResponse = await fetch(
      `${platformListener.origin}${evidence.downloadUrl}?user=${encodeURIComponent(user)}`,
    )
    assert.equal(evidenceResponse.status, 200)
    assert.ok((await evidenceResponse.arrayBuffer()).byteLength > 0)
    const forbiddenEvidence = await fetch(
      `${platformListener.origin}${evidence.downloadUrl}?user=${encodeURIComponent(`${user}_other`)}`,
    )
    assert.equal(forbiddenEvidence.status, 404)
  } finally {
    setCommandDispatcher()
    await executor.close()
    await evaluatorListener.close()
    await platformListener.close()
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN
  }
})
