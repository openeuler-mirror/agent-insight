import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('SWE-bench runner separates benchmark failures from infrastructure failures', () => {
  const evaluatorDir = path.resolve('benchmarks/swe-bench/evaluator')
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(evaluatorDir)})
from result_policy import classify_harness_result

status, error = classify_harness_result({
    "infra_failure": False,
    "patch_successfully_applied": False,
    "resolved": False,
    "tests_status": {
        "FAIL_TO_PASS": {"success": [], "failure": ["test_regression"]},
        "PASS_TO_PASS": {"success": ["test_existing"], "failure": []},
    },
}, False)
assert status == "completed"
assert error is None

status, error = classify_harness_result(None, True)
assert status == "submission_invalid"
assert error["code"] == "SWE_PATCH_APPLY_FAILED"
assert error["retryable"] is False

status, error = classify_harness_result({
    "infra_failure": True,
    "infra_failure_reason": "Docker unavailable",
}, False)
assert status == "failed"
assert error["code"] == "SWE_HARNESS_FAILED"
assert error["message"] == "Docker unavailable"
assert error["retryable"] is True

status, error = classify_harness_result(None, False)
assert status == "failed"
assert error["code"] == "SWE_HARNESS_RESULT_INVALID"

for malformed in (
    {"resolved": "false", "patch_successfully_applied": True, "tests_status": {}},
    {"resolved": False, "patch_successfully_applied": True},
    {
        "resolved": False,
        "patch_successfully_applied": True,
        "tests_status": {
            "FAIL_TO_PASS": {"success": [], "failure": "test_regression"},
            "PASS_TO_PASS": {"success": [], "failure": []},
        },
    },
):
    status, error = classify_harness_result(malformed, False)
    assert status == "failed"
    assert error["code"] == "SWE_HARNESS_RESULT_INVALID"
    assert error["retryable"] is True
`
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
