from dataclasses import dataclass

from .contracts import identifier
from .control import StorageError


DEFAULT_PROJECT_ID = 'default'


class ProjectUnavailable(StorageError):
    pass


@dataclass(frozen=True)
class ProjectContext:
    project_id: str
    workspace_id: str


def default_project_id(value=None):
    if value is None:
        return DEFAULT_PROJECT_ID
    identifier(value)
    if value != DEFAULT_PROJECT_ID:
        raise ValueError('only the default project is enabled')
    return value


def require_default_project(connection):
    row=connection.execute('SELECT status FROM projects WHERE project_id=?',(DEFAULT_PROJECT_ID,)).fetchone()
    if row is None or row[0]!='active':
        raise ProjectUnavailable('default project is not active')


def resolve_project(connection, workspace_id, project_id=None):
    selected=default_project_id(project_id)
    identifier(workspace_id)
    row=connection.execute("""SELECT pw.project_id FROM project_workspaces pw
        JOIN projects p ON p.project_id=pw.project_id AND p.status='active'
        JOIN workspaces w ON w.workspace_id=pw.workspace_id AND w.state='active'
        WHERE pw.workspace_id=? AND pw.project_id=?""",(workspace_id,selected)).fetchone()
    if row is None:
        raise ProjectUnavailable('workspace has no active binding in the selected project')
    return ProjectContext(row[0],workspace_id)
