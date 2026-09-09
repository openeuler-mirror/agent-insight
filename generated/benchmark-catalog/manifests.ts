// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog

import type { BenchmarkManifest } from '../../packages/benchmark-protocol/src/contracts'

export const generatedBenchmarkManifests = {
  "swe-bench": {
    "adapterKey": "swe-bench",
    "displayName": "SWE-bench",
    "protocols": {
      "agentTask": "agent-task/v1",
      "evaluation": "benchmark-evaluation/v1"
    },
    "requiredCapabilities": [
      "git-workspace/v1",
      "git-patch/v1"
    ],
    "defaultTimeoutSeconds": 1800,
    "requiredArtifacts": [
      {
        "name": "model.patch",
        "mediaType": "text/x-diff",
        "collector": "git-patch/v1",
        "maxBytes": 10485760
      }
    ],
    "schemas": {
      "case": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "swe-bench/case",
        "type": "object",
        "required": [
          "instance_id",
          "repo",
          "base_commit",
          "problem_statement",
          "patch",
          "test_patch",
          "FAIL_TO_PASS",
          "PASS_TO_PASS"
        ],
        "properties": {
          "instance_id": {
            "type": "string",
            "minLength": 1,
            "x-agent-visibility": "public"
          },
          "repo": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
            "x-agent-visibility": "public"
          },
          "base_commit": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{40}$",
            "x-agent-visibility": "public"
          },
          "problem_statement": {
            "type": "string",
            "minLength": 1,
            "x-agent-visibility": "public"
          },
          "hints_text": {
            "type": "string",
            "x-agent-visibility": "public"
          },
          "version": {
            "type": "string",
            "x-agent-visibility": "public"
          },
          "patch": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "test_patch": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "FAIL_TO_PASS": {
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ],
            "x-agent-visibility": "private"
          },
          "PASS_TO_PASS": {
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ],
            "x-agent-visibility": "private"
          },
          "environment_setup_commit": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "image": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "eval_script": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "eval_type": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "log_parser": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "created_at": {
            "type": "string",
            "x-agent-visibility": "private"
          },
          "difficulty": {
            "type": "string",
            "x-agent-visibility": "private"
          }
        },
        "additionalProperties": false
      },
      "rawResult": {
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
    },
    "evaluation": {
      "evaluatorKey": "swe-bench",
      "defaultTimeoutSeconds": 1800,
      "defaultResources": {
        "cpu": 4,
        "memoryMiB": 16384
      }
    },
    "result": {
      "primaryMetric": {
        "key": "resolved",
        "aggregation": "boolean-rate"
      }
    },
    "dataset": {
      "profiles": [
        {
          "key": "verified",
          "displayName": "SWE-bench Verified",
          "acceptedExtensions": [
            ".parquet"
          ],
          "expectedCaseCount": 500
        }
      ]
    },
    "presentation": {
      "caseTable": {
        "searchPaths": [
          "externalCaseId",
          "values.repo"
        ],
        "searchPlaceholder": "搜索 Instance ID 或仓库",
        "columns": [
          {
            "path": "input",
            "label": "任务输入",
            "type": "text"
          },
          {
            "path": "externalCaseId",
            "label": "Instance ID",
            "type": "code"
          },
          {
            "path": "values.repo",
            "label": "仓库",
            "type": "text"
          }
        ]
      },
      "referencePanel": {
        "title": "SWE-bench 官方测试契约",
        "description": "测试内容和 Gold Patch 只交给评测服务，不会发送给 Agent。",
        "columns": [
          {
            "path": "externalCaseId",
            "label": "Case",
            "type": "code"
          },
          {
            "path": "values.repo",
            "label": "仓库",
            "type": "text"
          },
          {
            "path": "values.base_commit",
            "label": "基线版本",
            "type": "code"
          }
        ]
      },
      "result": {
        "primaryMetric": {
          "path": "primaryMetric.value",
          "label": "Resolved",
          "type": "boolean"
        }
      }
    }
  }
} as const satisfies Record<string, BenchmarkManifest>

export function getGeneratedBenchmarkManifest(key: keyof typeof generatedBenchmarkManifests): BenchmarkManifest {
  return generatedBenchmarkManifests[key]
}
