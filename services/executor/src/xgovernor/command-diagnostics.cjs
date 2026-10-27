'use strict'

const { error } = require('./client.cjs')

const OPERATIONS = {
  'workspace-head': ['preparing', '读取镜像初始 Git HEAD'],
  'workspace-base': ['preparing', '检查数据集基线 commit'],
  'workspace-ancestry': ['preparing', '检查镜像与数据集基线关系'],
  'workspace-status': ['preparing', '检查镜像初始工作树'],
  'workspace-origin': ['preparing', '检查仓库来源'],
  'workspace-reset': ['preparing', '恢复工作区基线'],
  'workspace-clean': ['preparing', '清理工作区'],
  'patch-stage': ['collecting', '暂存 Agent 修改'],
  'patch-diff': ['collecting', '生成 model.patch'],
  'sandbox-command': ['unknown', '执行沙箱命令'],
}
const REASONS = [
  [/detected dubious ownership/i, 'GIT_OWNERSHIP', 'Git 拒绝访问工作区，请检查容器内仓库所有权或 safe.directory'],
  [/not a git repository/i, 'GIT_REPOSITORY_MISSING', '工作目录不是 Git 仓库，请检查 Case 镜像中的源码目录'],
  [/permission denied|operation not permitted|read-only file system/i, 'WORKSPACE_PERMISSION', '工作区权限不足或文件系统只读'],
  [/no space left on device|disk quota exceeded/i, 'DISK_FULL', '执行机或容器磁盘空间不足'],
  [/index\.lock.*(?:file exists|unable to create)|another git process/i, 'GIT_INDEX_LOCKED', 'Git 索引被其他进程或残留锁占用'],
  [/not a valid object|bad object|invalid object name|unknown revision|bad revision|could not get object info/i, 'GIT_REVISION_MISSING', 'Git commit 不存在，请检查 Case 镜像与任务基线是否匹配'],
  [/No such remote/i, 'GIT_REMOTE_MISSING', '仓库没有所需 remote'],
]

function commandFailure(result, operation) {
  if (!Object.hasOwn(OPERATIONS, operation)) operation = 'sandbox-command'
  const [phase, label] = OPERATIONS[operation]
  const output = typeof result.stderr === 'string' ? Buffer.from(result.stderr.slice(0, 16384)).subarray(0, 16384).toString('utf8') : ''
  let reason = REASONS.find(([pattern]) => pattern.test(output))
  if (result.timed_out) reason = [null, 'COMMAND_TIMEOUT', '沙箱命令执行超时']
  else if (!reason && operation === 'workspace-ancestry' && result.exit_code === 1) reason = [null, 'GIT_BASELINE_UNRELATED', '镜像初始 HEAD 不包含数据集基线，请检查 Case 镜像是否匹配']
  else if (!reason && operation === 'workspace-base') reason = [null, 'GIT_REVISION_MISSING', '镜像中无法读取数据集基线 commit']
  reason ||= [null, 'COMMAND_FAILED', '命令失败，原始输出未通过安全展示规则']
  const exitCode = Number.isInteger(result.exit_code) && result.exit_code >= 0 && result.exit_code <= 255 ? result.exit_code : null
  const diagnostic = { phase, operation, exitCode, timedOut: result.timed_out === true, reason: reason[1], message: reason[2] }
  return Object.assign(error('SANDBOX_COMMAND_FAILED', `${phase === 'collecting' ? '提交物收集' : phase === 'preparing' ? '工作区准备' : '沙箱执行'}失败：${label}（${result.timed_out ? '超时' : `退出码 ${exitCode ?? '未知'}`}）；${reason[2]}`), { runFacts: { sandboxDiagnostic: diagnostic } })
}

module.exports = { commandFailure }
