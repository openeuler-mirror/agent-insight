'use strict'

// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog

const path = require('node:path')

const generatedEvaluatorDescriptors = [
  {
    "key": "swe-bench",
    "benchmarkKey": "swe-bench",
    "runtime": "controller-container",
    "command": "node",
    "entrypoint": path.resolve(__dirname, "../../benchmarks/swe-bench/evaluator/entrypoint.cjs"),
    "smokeEntrypoint": path.resolve(__dirname, "../../benchmarks/swe-bench/smoke/index.cjs"),
    "artifactDigest": "sha256:856f4587f4d11793319ade7c51d479b04ae68fe02e1d791d6f215768bebc35c6",
    "network": "deny",
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
        "resolved"
      ],
      "properties": {
        "instanceId": {
          "type": "string"
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
