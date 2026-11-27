/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

-- AlterTable
ALTER TABLE "AgentEvalDataset" ADD COLUMN "generationSource" TEXT;
ALTER TABLE "AgentEvalDataset" ADD COLUMN "generationStatus" TEXT;

-- CreateTable
CREATE TABLE "TraceDatasetGenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "stageIndex" INTEGER NOT NULL DEFAULT 0,
    "generatedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "captureState" TEXT NOT NULL DEFAULT 'pending',
    "captureManifestHash" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextEligibleAt" DATETIME,
    "cleanupPending" BOOLEAN NOT NULL DEFAULT false,
    "deletionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TraceDatasetGenerationJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "AgentEvalDataset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TraceDatasetOperationReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "datasetId" TEXT,
    "jobId" TEXT,
    "deletionId" TEXT,
    "outcome" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "clockHighWaterMs" BIGINT
);

-- CreateIndex
CREATE UNIQUE INDEX "TraceDatasetGenerationJob_datasetId_key" ON "TraceDatasetGenerationJob"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "TraceDatasetGenerationJob_deletionId_key" ON "TraceDatasetGenerationJob"("deletionId");

-- CreateIndex
CREATE INDEX "TraceDatasetGenerationJob_owner_status_createdAt_idx" ON "TraceDatasetGenerationJob"("owner", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TraceDatasetGenerationJob_status_leaseUntil_idx" ON "TraceDatasetGenerationJob"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "TraceDatasetGenerationJob_owner_requestId_key" ON "TraceDatasetGenerationJob"("owner", "requestId");

-- CreateIndex
CREATE INDEX "TraceDatasetOperationReceipt_expiresAt_idx" ON "TraceDatasetOperationReceipt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TraceDatasetOperationReceipt_ownerKey_kind_operationKey_key" ON "TraceDatasetOperationReceipt"("ownerKey", "kind", "operationKey");

