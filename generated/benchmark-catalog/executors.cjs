'use strict'

// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog

const path = require('node:path')

const generatedGitSourcePolicyDescriptors = [
  { benchmarkKey: "swe-bench", modulePath: path.resolve(__dirname, "../../benchmarks/swe-bench/executor/git-source-policy.cjs") },
]

const generatedEnvironmentPreparationDescriptors = [
  { datasetAdapterKey: "swe-bench", protocol: 'execution-environment/v1', modulePath: path.resolve(__dirname, "../../benchmarks/swe-bench/executor/environment.cjs") },
  { datasetAdapterKey: "zsoft-l1", protocol: 'execution-environment/v1', modulePath: path.resolve(__dirname, "../../benchmarks/zsoft-l1/executor/environment.cjs") },
]

const generatedExecutorPackageFiles = [
  "benchmarks/swe-bench/executor/environment.cjs",
  "benchmarks/swe-bench/executor/git-source-policy.cjs",
  "benchmarks/zsoft-l1/executor/environment.cjs"
]

module.exports = { generatedGitSourcePolicyDescriptors, generatedEnvironmentPreparationDescriptors, generatedExecutorPackageFiles }
