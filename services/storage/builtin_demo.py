from .control import StorageError
from .datasets import DatasetStore
from .trace_metadata import TraceMetadata


AGENT_NAME = 'messages-log-analyzer'
AGENT_DESCRIPTION = '内置示例：messages 日志安全分析 Agent（新用户注册时自动注入的演示 trace）'
SKILL_NAME = 'linux-messages-auth-triage-demo'
SKILL_DESCRIPTION = '内置示例 Skill：离线分析 Linux messages 日志中的认证失败、暴力破解、用户枚举与登录异常事件。'
DATASET_NAME = 'messages 日志分析（内置示例）'
TASK_PREFIX = 'builtin_msg_'


def cleanup(repository, token, workspace):
    control = repository.control
    datasets = DatasetStore(control)
    traces = TraceMetadata(control)
    result = dict(executions=0, sessions=0, agents=0, datasets=0, skills=0)
    with control.transaction() as con:
        scope, _ = repository._scope(con, token, workspace, 'delete')
        repository.iam._workspace(scope, workspace, 'write')
        rows = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND owner_principal_id=? AND state='active' AND kind IN ('registeredAgent','skill')", (workspace, scope.principal_id)).fetchall()
        heads = con.execute("SELECT h.* FROM dataset_compat_heads h JOIN iam_resource_access a ON a.workspace_id=h.workspace_id AND a.resource_kind='asset' AND a.resource_id=h.asset_id WHERE h.workspace_id=? AND h.state='active' AND a.owner_principal_id=?", (workspace, scope.principal_id)).fetchall()
        aliases = con.execute("SELECT i.trace_id,i.alias_id FROM trace_legacy_ids i JOIN trace_locators l ON l.workspace_id=i.workspace_id AND l.trace_id=i.trace_id JOIN iam_resource_access a ON a.workspace_id=i.workspace_id AND a.resource_kind='trace' AND a.resource_id=i.trace_id WHERE i.workspace_id=? AND i.alias_kind='task' AND l.state='active' AND a.owner_principal_id=?", (workspace, scope.principal_id)).fetchall()
        if max(len(rows), len(heads), len(aliases)) > 10000:
            raise StorageError('Demo cleanup exceeds owner scope budget')
        for trace_id in {row['trace_id'] for row in aliases if row['alias_id'].startswith(TASK_PREFIX)}:
            if traces._delete(con, token, workspace, trace_id):
                result['executions'] += 1
                result['sessions'] += 1
        for head in heads:
            manifest = datasets._load(head['manifest_hash'], head['manifest_ref'])
            if manifest['metadata'].get('name') == DATASET_NAME and not head['read_only']:
                datasets._delete_tx(con, token, workspace, head['dataset_id'], operation_key='builtin-demo-cleanup:'+head['dataset_id']+':'+str(head['lifecycle_revision']))
                result['datasets'] += 1
        touched = set()
        username = None
        for row in rows:
            data = repository._data(dict(row))
            kind = row['kind']
            matches = (kind == 'registeredAgent' and data.get('name') == AGENT_NAME and data.get('description') == AGENT_DESCRIPTION) or (kind == 'skill' and data.get('name') == SKILL_NAME and data.get('description') == SKILL_DESCRIPTION and data.get('author') is None and data.get('isUploaded') is False)
            if matches:
                username = row['legacy_username']
                repository._delete(con, workspace, kind, dict(row), touched)
                result['agents' if kind == 'registeredAgent' else 'skills'] += 1
        for kind in touched:
            repository._bump_scope(con, workspace, scope.principal_id, username, kind)
        if touched:
            repository._bump_scope(con, workspace, scope.principal_id, username)
    return result
