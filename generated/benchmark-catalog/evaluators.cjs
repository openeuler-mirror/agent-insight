'use strict'

// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog

const path = require('node:path')

const generatedEvaluatorDescriptors = [
  {
    "key": "swe-bench",
    "benchmarkKey": "swe-bench",
    "runtime": "oci-container",
    "command": "node",
    "entrypoint": "/app/benchmarks/swe-bench/evaluator/entrypoint.cjs",
    "imageProvider": path.resolve(__dirname, "../../benchmarks/swe-bench/evaluator/images.cjs"),
    "image": "agent-insight-benchmark-runtime-swe-bench:artifact-f253ae9503777e9f61e4fb325bc86e405cee7449f6a3f79d52aacf611e7135b6",
    "dockerfile": path.resolve(__dirname, "../../benchmarks/swe-bench/evaluator/Dockerfile"),
    "smokeEntrypoint": path.resolve(__dirname, "../../benchmarks/swe-bench/smoke/index.cjs"),
    "runtimeSmokeEntrypoint": "/app/benchmarks/swe-bench/smoke/index.cjs",
    "artifactDigest": "sha256:f253ae9503777e9f61e4fb325bc86e405cee7449f6a3f79d52aacf611e7135b6",
    "network": "deny",
    "resources": {
      "cpu": 4,
      "memoryMiB": 16384,
      "timeoutSeconds": 1800
    },
    "requiredArtifacts": [
      {
        "name": "model.patch",
        "mediaType": "text/x-diff",
        "collector": "git-patch/v1",
        "maxBytes": 10485760
      }
    ],
    "rawResultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "swe-bench/raw-result",
      "type": "object",
      "required": [
        "instanceId",
        "resolved",
        "patchSuccessfullyApplied",
        "failToPass",
        "passToPass",
        "officialReport"
      ],
      "properties": {
        "instanceId": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "patchSuccessfullyApplied": {
          "type": "boolean"
        },
        "failToPass": {
          "type": "object",
          "required": [
            "passed",
            "total"
          ],
          "properties": {
            "passed": {
              "type": "integer",
              "minimum": 0
            },
            "total": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": false
        },
        "passToPass": {
          "type": "object",
          "required": [
            "passed",
            "total"
          ],
          "properties": {
            "passed": {
              "type": "integer",
              "minimum": 0
            },
            "total": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": false
        },
        "officialReport": {
          "type": "object"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "key": "zsoft-l1",
    "benchmarkKey": "zsoft-l1",
    "runtime": "oci-container",
    "command": "python3",
    "entrypoint": "/opt/agent-insight/zsoft/entrypoint.py",
    "imageProvider": path.resolve(__dirname, "../../benchmarks/zsoft-l1/evaluator/images.cjs"),
    "assets": {
      "image": "swr.cn-east-3.myhuaweicloud.com/agent-insight/zsoft-l1-userspace-x86-64@sha256:af1e63c5cacb1753ceec85de245f129bdc63bb3ae15dca961248d17fa7e27a3b",
      "sourcePath": "/opt/agent-insight/zsoft-l1/20261019-full-v1",
      "releaseId": "20261019-full-v1",
      "bundleDigest": "sha256:d73939d50ff543cbbe7a5a23e15ece361ed89d0dd998ab0f3cdace63e23621f9",
      "verifyCommand": "python3",
      "verifyEntrypoint": path.resolve(__dirname, "../../benchmarks/zsoft-l1/evaluator/verify_assets.py")
    },
    "image": "agent-insight-benchmark-runtime-zsoft-l1:artifact-80b0412bc058470077918c7d185a55db9be659f2ecf544d40733a2ef12085c4d",
    "dockerfile": path.resolve(__dirname, "../../benchmarks/zsoft-l1/evaluator/Dockerfile"),
    "artifactDigest": "sha256:80b0412bc058470077918c7d185a55db9be659f2ecf544d40733a2ef12085c4d",
    "network": "deny",
    "resources": {
      "cpu": 4,
      "memoryMiB": 8192,
      "timeoutSeconds": 900
    },
    "requiredArtifacts": [
      {
        "name": "poc",
        "mediaType": "application/octet-stream",
        "collector": "single-file/v1",
        "maxBytes": 1048576
      }
    ],
    "rawResultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "taskId",
        "submissionSha256",
        "bundleDigest",
        "taskDigest",
        "status",
        "success",
        "sourceTaskDigest"
      ],
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"
        },
        "submissionSha256": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$"
        },
        "bundleDigest": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$"
        },
        "taskDigest": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$"
        },
        "status": {
          "enum": [
            "completed",
            "invalid_submission",
            "infrastructure_error"
          ]
        },
        "success": {
          "type": "boolean"
        },
        "sourceTaskDigest": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$"
        }
      },
      "additionalProperties": false
    }
  }
]

module.exports = { generatedEvaluatorDescriptors }
