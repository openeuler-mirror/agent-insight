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
  }
]

module.exports = { generatedEvaluatorDescriptors }
