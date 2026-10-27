// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog
// Copyright (c) 2026 Huawei Technologies Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { BenchmarkDatasetPreparer } from '../../packages/benchmark-protocol/src/contracts'
import { sweBenchDatasetPreparer as preparer0 } from '../../benchmarks/swe-bench/dataset/prepare'
import { zsoftDatasetPreparer as preparer1 } from '../../benchmarks/zsoft-l1/dataset/prepare'
export const generatedBenchmarkDatasetPreparers: readonly { adapterKey: string; preparer: BenchmarkDatasetPreparer }[] = [{ adapterKey: "swe-bench", preparer: preparer0 }, { adapterKey: "zsoft-l1", preparer: preparer1 }]
