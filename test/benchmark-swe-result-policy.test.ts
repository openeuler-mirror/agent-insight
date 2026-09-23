import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('managed SWE Harness cannot pull behind the pool and does not remove its own Runtime', () => {
  const source = fs.readFileSync(path.resolve('benchmarks/swe-bench/evaluator/run.py'), 'utf8')
  const script = `
import ast
tree = ast.parse(${JSON.stringify(source)})
names = {"PreparedImages", "ControlledDockerClient", "ControlledContainers", "cleanup_labeled"}
selected = ast.Module(body=[node for node in tree.body if getattr(node, "name", "") in names], type_ignores=[])
exec(compile(selected, "runner-contract", "exec"))

class Images:
    def get(self, ref):
        return ref
images = PreparedImages(Images())
assert images.get("frozen") == "frozen"
for operation in (images.pull, images.build):
    try:
        operation("unmanaged")
    except RuntimeError:
        pass
    else:
        raise AssertionError("Runtime bypassed shared pool")

class Container:
    def __init__(self, role):
        self.labels = {"agent-insight.role": role}
        self.removed = False
    def remove(self, **kwargs):
        self.removed = True
runtime, case = Container("evaluator-runtime"), Container("case")
class Containers:
    def list(self, **kwargs):
        return [runtime, case]
class Client:
    containers = Containers()
    images = Images()
    api = None
client = Client()
assert cleanup_labeled(client, "evaluation") == {"status": "succeeded"}
assert case.removed and not runtime.removed
assert isinstance(ControlledDockerClient(client, "evaluation", 1, 1024, "deny", True).images, PreparedImages)
assert ControlledDockerClient(client, "evaluation", 1, 1024, "deny").images is client.images
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

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
