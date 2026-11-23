// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog
// Copyright (c) 2026 Huawei Technologies Co., Ltd.
// SPDX-License-Identifier: Apache-2.0

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
    "defaultTimeoutSeconds": 600,
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
      "evaluator": {
        "displayName": "SWE-bench Official Harness",
        "description": "使用 SWE-bench 官方测试契约验证 Agent 提交。",
        "runMode": "Official Harness",
        "outputDescription": "输出 Resolved 及 FAIL_TO_PASS、PASS_TO_PASS 通过情况。"
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
          "type": "boolean",
          "aggregateLabel": "Resolve Rate",
          "trueLabel": "已解决",
          "falseLabel": "未解决"
        }
      },
      "artifacts": [
        {
          "source": "submission",
          "name": "model.patch",
          "label": "Agent Patch",
          "order": 10
        },
        {
          "source": "evidence",
          "kind": "official-report",
          "label": "报告输出",
          "order": 20
        },
        {
          "source": "evidence",
          "kind": "test-output",
          "label": "测试输出",
          "order": 30
        },
        {
          "source": "evidence",
          "kind": "harness-log",
          "label": "运行日志",
          "order": 40
        }
      ]
    }
  },
  "zsoft-l1": {
    "adapterKey": "zsoft-l1",
    "displayName": "ZSoft L1",
    "protocols": {
      "agentTask": "agent-task/v1",
      "evaluation": "benchmark-evaluation/v1"
    },
    "requiredCapabilities": [
      "zsoft-tasks-workspace/v3",
      "single-file/v1"
    ],
    "defaultTimeoutSeconds": 900,
    "requiredArtifacts": [
      {
        "name": "poc",
        "mediaType": "application/octet-stream",
        "collector": "single-file/v1",
        "maxBytes": 1048576
      }
    ],
    "schemas": {
      "case": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": [
          "public",
          "private"
        ],
        "properties": {
          "public": {
            "type": "object",
            "required": [
              "taskId",
              "title",
              "description",
              "submissionKind",
              "maxBytes",
              "tags"
            ],
            "properties": {
              "taskId": {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"
              },
              "title": {
                "type": "string",
                "minLength": 1
              },
              "description": {
                "type": "string",
                "minLength": 1
              },
              "submissionKind": {
                "enum": [
                  "python",
                  "c",
                  "binary"
                ]
              },
              "maxBytes": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "tags": {
                "type": "array",
                "maxItems": 32,
                "items": {
                  "type": "string"
                }
              }
            },
            "additionalProperties": false,
            "x-agent-visibility": "public"
          },
          "private": {
            "type": "object",
            "required": [
              "sourceTaskDigest"
            ],
            "properties": {
              "revision": {
                "type": "string",
                "pattern": "^[0-9a-f]{40}$"
              },
              "sourceTaskDigest": {
                "type": "string",
                "pattern": "^sha256:[0-9a-f]{64}$"
              }
            },
            "additionalProperties": false,
            "x-agent-visibility": "private"
          }
        },
        "additionalProperties": false
      },
      "rawResult": {
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
    },
    "evaluation": {
      "evaluatorKey": "zsoft-l1",
      "defaultTimeoutSeconds": 900,
      "defaultResources": {
        "cpu": 4,
        "memoryMiB": 8192
      }
    },
    "result": {
      "primaryMetric": {
        "key": "success",
        "aggregation": "boolean-rate"
      }
    },
    "dataset": {
      "profiles": [
        {
          "key": "l1",
          "displayName": "ZSoft L1",
          "acceptedExtensions": [],
          "version": "official-directory/v1",
          "acceptedSourceKinds": [
            "directory"
          ]
        }
      ]
    },
    "presentation": {
      "caseTable": {
        "searchPaths": [
          "externalCaseId",
          "values.title"
        ],
        "searchPlaceholder": "搜索 Task ID 或题目",
        "columns": [
          {
            "path": "input",
            "label": "任务",
            "type": "text"
          },
          {
            "path": "externalCaseId",
            "label": "Task ID",
            "type": "code"
          },
          {
            "path": "values.submissionKind",
            "label": "提交类型",
            "type": "text"
          }
        ]
      },
      "execution": {
        "notice": "执行客户端从 MCTS 的 testcases_union/config.env 读取 ZSOFT_TASKS_DIR；题目 ID 由平台自动下发。"
      },
      "evaluator": {
        "displayName": "ZSoft L1 Official Judge",
        "description": "在自有评测服务中验证单文件 PoC。",
        "runMode": "Official Judge",
        "outputDescription": "输出官方 success、提交有效性和基础设施状态。"
      },
      "result": {
        "primaryMetric": {
          "path": "primaryMetric.value",
          "label": "Success",
          "type": "boolean",
          "aggregateLabel": "Success Rate",
          "trueLabel": "成功",
          "falseLabel": "未成功"
        }
      },
      "artifacts": [
        {
          "source": "submission",
          "name": "poc",
          "label": "PoC",
          "order": 10
        },
        {
          "source": "evidence",
          "kind": "official-report",
          "label": "评测报告",
          "order": 20
        },
        {
          "source": "evidence",
          "kind": "official-record",
          "label": "官方执行记录",
          "order": 30
        },
        {
          "source": "evidence",
          "kind": "harness-log",
          "label": "运行日志",
          "order": 40
        },
        {
          "source": "evidence",
          "kind": "official-output-archive",
          "label": "完整官方输出",
          "order": 50
        }
      ]
    }
  }
} as const satisfies Record<string, BenchmarkManifest>

export function getGeneratedBenchmarkManifest(key: keyof typeof generatedBenchmarkManifests): BenchmarkManifest {
  return generatedBenchmarkManifests[key]
}
