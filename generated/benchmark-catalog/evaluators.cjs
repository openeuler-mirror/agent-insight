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
    "image": "agent-insight-benchmark-runtime-swe-bench:artifact-8eb915a3161ea9eb81a1ec7394b5293cc332df1f524eafa27f2df04f383d9309",
    "dockerfile": path.resolve(__dirname, "../../benchmarks/swe-bench/evaluator/Dockerfile"),
    "smokeEntrypoint": path.resolve(__dirname, "../../benchmarks/swe-bench/smoke/index.cjs"),
    "runtimeSmokeEntrypoint": "/app/benchmarks/swe-bench/smoke/index.cjs",
    "artifactDigest": "sha256:8eb915a3161ea9eb81a1ec7394b5293cc332df1f524eafa27f2df04f383d9309",
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
    "requiresPrebuiltRuntime": true,
    "command": "python3",
    "entrypoint": "/opt/agent-insight/zsoft/entrypoint.py",
    "image": "agent-insight-benchmark-runtime-zsoft-l1:artifact-55650977087da9d6ff2bd3b8d06538cea8f9e04b3b3ed26e822dcc4b04f87a6d",
    "dockerfile": path.resolve(__dirname, "../../benchmarks/zsoft-l1/evaluator/Dockerfile"),
    "artifactDigest": "sha256:55650977087da9d6ff2bd3b8d06538cea8f9e04b3b3ed26e822dcc4b04f87a6d",
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
        "success"
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
        }
      },
      "additionalProperties": false
    }
  }
]

module.exports = { generatedEvaluatorDescriptors }
