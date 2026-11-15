import hashlib
import hmac
import json
import re
import secrets
import unicodedata
import uuid
from dataclasses import dataclass

from .contracts import canonical_json, content_hash, identifier, revision
from .control import Conflict, StorageError
from .projects import DEFAULT_PROJECT_ID, ProjectUnavailable, require_default_project


class Unauthorized(StorageError):
    pass


class Forbidden(StorageError):
    pass


CAPABILITIES = frozenset({'read', 'write', 'execute', 'publish', 'delete', 'members'})
ROLE_CAPABILITIES = {
    'owner': CAPABILITIES,
    'admin': CAPABILITIES,
    'member': frozenset({'read', 'write', 'execute', 'delete'}),
    'viewer': frozenset({'read'}),
    'personal': CAPABILITIES - {'members'},
}
RESOURCE_KINDS = frozenset({'trace', 'asset', 'run', 'snapshot', 'artifact'})
PASSWORD_ITERATIONS = 600_000


@dataclass(frozen=True)
class WorkspaceGrant:
    workspace_id: str
    role: str
    group_id: str | None
    policy_revision: int
    membership_etag: int
    binding_revision: int
    project_id: str = DEFAULT_PROJECT_ID


@dataclass(frozen=True)
class AccessScope:
    principal_id: str
    allowed_workspace_ids: tuple
    grants: tuple
    capabilities: frozenset
    fingerprint: str
    project_id: str = DEFAULT_PROJECT_ID


def _login_name(value):
    if not isinstance(value, str):
        raise ValueError('invalid login name')
    value = unicodedata.normalize('NFKC', value.strip()).casefold()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.@+\-]{0,127}', value):
        raise ValueError('login name must normalize to 1..128 ASCII login characters')
    return value


def _password(value):
    if not isinstance(value, str) or not 15 <= len(value) <= 1024:
        raise ValueError('password must contain 15..1024 characters')
    return value.encode('utf-8')


def _capabilities(values):
    if isinstance(values, str):
        raise ValueError('capabilities must be a collection')
    values = frozenset(values)
    if not values or not values <= CAPABILITIES:
        raise ValueError('invalid capability set')
    return values


class IAMStore:
    """Trusted provisioning port; web handlers must use credential-checked methods."""

    def __init__(self, control):
        self.control = control
        self.clock = control.clock
        with control.read_transaction() as con:
            if con.execute('SELECT 1 FROM schema_meta WHERE version=3').fetchone() is None:
                raise StorageError('apply the explicit 003 project migration before enabling IAM')

    def create_principal(self, principal_id, login_name, display_name):
        principal_id = identifier(principal_id)
        now = self.clock()
        with self.control.transaction() as con:
            con.execute('INSERT INTO iam_principals(principal_id,normalized_login_name,display_name,status,auth_version,created_at_ms,updated_at_ms) VALUES(?,?,?,\'active\',1,?,?)',
                        (principal_id, _login_name(login_name), identifier(display_name), now, now))

    def set_password(self, principal_id, password):
        salt = secrets.token_bytes(32)
        digest = hashlib.pbkdf2_hmac('sha256', _password(password), salt, PASSWORD_ITERATIONS).hex()
        parameters = canonical_json({'iterations': PASSWORD_ITERATIONS, 'salt': salt.hex()})
        now = self.clock()
        with self.control.transaction() as con:
            principal = con.execute('SELECT auth_version FROM iam_principals WHERE principal_id=?', (principal_id,)).fetchone()
            if principal is None:
                raise Conflict('principal does not exist')
            credential = con.execute('SELECT credential_version FROM iam_password_credentials WHERE principal_id=?', (principal_id,)).fetchone()
            if credential:
                con.execute('UPDATE iam_password_credentials SET password_hash=?,scheme=?,parameters_json=?,credential_version=?,changed_at_ms=? WHERE principal_id=?',
                            (digest, 'pbkdf2-sha256', parameters, revision(credential[0]+1), now, principal_id))
            else:
                con.execute('INSERT INTO iam_password_credentials VALUES(?,?,?,?,1,?)', (principal_id,digest,'pbkdf2-sha256',parameters,now))
            con.execute('UPDATE iam_principals SET auth_version=?,updated_at_ms=? WHERE principal_id=?', (revision(principal[0]+1),now,principal_id))

    def set_principal_status(self, principal_id, status):
        if status not in {'active','disabled'}:
            raise ValueError('invalid principal status')
        with self.control.transaction() as con:
            row=con.execute('SELECT auth_version FROM iam_principals WHERE principal_id=?',(principal_id,)).fetchone()
            if not row:
                raise Conflict('principal does not exist')
            con.execute('UPDATE iam_principals SET status=?,auth_version=?,updated_at_ms=? WHERE principal_id=?',
                        (status,revision(row[0]+1),self.clock(),principal_id))

    def create_group(self, group_id, group_key, name, owner_principal_id):
        now=self.clock()
        for value in (group_id,group_key,name,owner_principal_id): identifier(value)
        with self.control.transaction() as con:
            owner=con.execute("SELECT 1 FROM iam_principals WHERE principal_id=? AND status='active'",(owner_principal_id,)).fetchone()
            if not owner:
                raise Conflict('group owner must be an active principal')
            con.execute("INSERT INTO iam_groups VALUES(?,?,?,'active',?,1,?,?)",(group_id,group_key,name,owner_principal_id,now,now))
            con.execute("INSERT INTO iam_group_memberships VALUES(?,?,'owner','active',1,?,?)",(group_id,owner_principal_id,now,now))

    def _membership(self, con, group_id, principal_id, role, status, expected_etag):
        if role not in {'owner','admin','member','viewer'} or status not in {'active','disabled'}:
            raise ValueError('invalid membership')
        now=self.clock()
        if expected_etag == 0:
            con.execute('INSERT INTO iam_group_memberships VALUES(?,?,?,?,1,?,?)',(group_id,principal_id,role,status,now,now))
            return 1
        revision(expected_etag)
        etag=revision(expected_etag+1)
        result=con.execute('UPDATE iam_group_memberships SET role=?,status=?,etag=?,updated_at_ms=? WHERE group_id=? AND principal_id=? AND etag=?',
                           (role,status,etag,now,group_id,principal_id,expected_etag))
        if result.rowcount != 1:
            raise Conflict('membership changed concurrently')
        if status=='disabled':
            con.execute('UPDATE iam_api_credentials SET revoked_at_ms=CASE WHEN issued_at_ms>? THEN issued_at_ms ELSE ? END WHERE principal_id=? AND revoked_at_ms IS NULL AND workspace_id IN (SELECT workspace_id FROM iam_workspace_bindings WHERE owner_group_id=?)',(now,now,principal_id,group_id))
        return etag

    def set_membership_for_provisioning(self, group_id, principal_id, role, *, status='active', expected_etag=0):
        with self.control.transaction() as con:
            return self._membership(con,group_id,principal_id,role,status,expected_etag)

    def set_membership(self, credential, group_id, principal_id, role, *, status='active', expected_etag):
        with self.control.transaction() as con:
            scope=self._scope(con,credential)
            if 'members' not in scope.capabilities:
                raise Forbidden('credential cannot manage memberships')
            membership=con.execute("SELECT m.role FROM iam_group_memberships m JOIN iam_groups g ON g.group_id=m.group_id WHERE m.group_id=? AND m.principal_id=? AND m.status='active' AND g.status='active'",(group_id,scope.principal_id)).fetchone()
            old=con.execute('SELECT role FROM iam_group_memberships WHERE group_id=? AND principal_id=?',(group_id,principal_id)).fetchone()
            if not membership or membership[0] not in {'owner','admin'}:
                raise Forbidden('group management is not granted')
            # A workspace-bound ingestion key is never a group-management credential.
            if credential.startswith('api_'):
                raise Forbidden('API credentials cannot manage group membership')
            if membership[0]=='admin' and (role in {'owner','admin'} or (old and old[0] in {'owner','admin'})):
                raise Forbidden('only an owner may manage privileged memberships')
            return self._membership(con,group_id,principal_id,role,status,expected_etag)

    def bind_workspace(self, workspace_id, *, group_id=None, principal_id=None):
        if (group_id is None)==(principal_id is None):
            raise ValueError('choose exactly one group or personal owner')
        now=self.clock()
        with self.control.transaction() as con:
            con.execute('INSERT INTO iam_workspace_bindings VALUES(?,?,?,?,1,?,?)',
                        (workspace_id,'group' if group_id else 'personal',group_id,principal_id,now,now))

    def _issue_session(self, con, principal_id, ttl_ms):
        if type(ttl_ms) is not int or not 0<ttl_ms<=86_400_000:
            raise ValueError('session TTL must be 1ms..24h')
        row=con.execute("SELECT auth_version FROM iam_principals WHERE principal_id=? AND status='active'",(principal_id,)).fetchone()
        if not row:
            raise Unauthorized('invalid credentials')
        token='session_'+secrets.token_urlsafe(32)
        now=self.clock()
        con.execute('INSERT INTO iam_sessions VALUES(?,?,?,?,?,?,NULL)',
                    (str(uuid.uuid4()),principal_id,hashlib.sha256(token.encode()).hexdigest(),row[0],now,now+ttl_ms))
        return token

    def issue_session_for_provisioning(self, principal_id, *, ttl_ms=3_600_000):
        with self.control.transaction() as con:
            return self._issue_session(con,principal_id,ttl_ms)

    def login(self, login_name, password, *, ttl_ms=3_600_000):
        try:
            normalized=_login_name(login_name)
        except ValueError:
            normalized=''
        if not isinstance(password,str) or len(password)>1024:
            raise Unauthorized('invalid credentials')
        with self.control.read_transaction() as con:
            saved=con.execute('SELECT p.principal_id,p.status,p.auth_version,c.password_hash,c.scheme,c.parameters_json FROM iam_principals p JOIN iam_password_credentials c ON c.principal_id=p.principal_id WHERE p.normalized_login_name=?',(normalized,)).fetchone()
            row=dict(saved) if saved else None
        parameters={'salt':'00'*32,'iterations':PASSWORD_ITERATIONS}
        expected='00'*32
        supported=False
        if row:
            try:
                parameters=json.loads(row['parameters_json'])
                supported=(row['scheme']=='pbkdf2-sha256' and type(parameters['iterations']) is int
                           and PASSWORD_ITERATIONS<=parameters['iterations']<=2_000_000
                           and re.fullmatch('[0-9a-f]{64}',parameters['salt']) is not None)
                expected=row['password_hash']
            except (ValueError,KeyError,TypeError):
                supported=False
        if not supported:
            parameters={'salt':'00'*32,'iterations':PASSWORD_ITERATIONS}
        actual=hashlib.pbkdf2_hmac('sha256',password.encode('utf-8'),bytes.fromhex(parameters['salt']),parameters['iterations']).hex()
        if not row or not supported or not hmac.compare_digest(actual,expected) or row['status']!='active':
            raise Unauthorized('invalid credentials')
        with self.control.transaction() as con:
            current=con.execute('SELECT p.status,p.auth_version,c.password_hash FROM iam_principals p JOIN iam_password_credentials c ON c.principal_id=p.principal_id WHERE p.principal_id=?',(row['principal_id'],)).fetchone()
            if not current or current['status']!='active' or current['auth_version']!=row['auth_version'] or not hmac.compare_digest(current['password_hash'],expected):
                raise Unauthorized('credentials changed during authentication')
            return self._issue_session(con,row['principal_id'],ttl_ms)

    def _authenticate(self, con, credential):
        if not isinstance(credential,str) or not re.fullmatch(r'(session|api)_[A-Za-z0-9_-]{43}',credential):
            raise Unauthorized('invalid credentials')
        token_hash=hashlib.sha256(credential.encode()).hexdigest()
        is_api=credential.startswith('api_')
        table='iam_api_credentials' if is_api else 'iam_sessions'
        token_column='token_hash' if is_api else 'session_token_hash'
        row=con.execute(f'SELECT c.*,p.status AS principal_status,p.auth_version AS current_auth_version FROM {table} c JOIN iam_principals p ON p.principal_id=c.principal_id WHERE c.{token_column}=?',(token_hash,)).fetchone()
        return self._validate_authenticated_row(row),is_api

    def _validate_authenticated_row(self,row):
        now=self.clock()
        if not row or row['principal_status']!='active' or row['auth_version']!=row['current_auth_version'] or row['revoked_at_ms'] is not None or not row['issued_at_ms']<=now<row['expires_at_ms']:
            raise Unauthorized('invalid or expired credentials')
        return row

    def _scope_registered_credential(self,con,credential_id,kind):
        if kind not in {'api','session'}:raise Unauthorized('invalid registered credential kind')
        identifier(credential_id);is_api=kind=='api';table='iam_api_credentials' if is_api else 'iam_sessions';key='credential_id' if is_api else 'session_id'
        row=con.execute(f'SELECT c.*,p.status AS principal_status,p.auth_version AS current_auth_version FROM {table} c JOIN iam_principals p ON p.principal_id=c.principal_id WHERE c.{key}=?',(credential_id,)).fetchone()
        return self._scope_authenticated(con,self._validate_authenticated_row(row),is_api)

    def _scope(self, con, credential):
        row,is_api=self._authenticate(con,credential)
        return self._scope_authenticated(con,row,is_api)

    def _scope_authenticated(self,con,row,is_api):
        principal_id=row['principal_id']
        try:
            require_default_project(con)
        except ProjectUnavailable as exc:
            raise Forbidden(str(exc)) from None
        capabilities=_capabilities(json.loads(row['capabilities_json'])) if is_api else CAPABILITIES
        rows=con.execute("""SELECT b.*,g.policy_revision,m.role,m.etag AS membership_etag FROM iam_workspace_bindings b
            JOIN workspaces w ON w.workspace_id=b.workspace_id AND w.state='active'
            JOIN project_workspaces pw ON pw.workspace_id=w.workspace_id AND pw.project_id='default'
            LEFT JOIN iam_groups g ON g.group_id=b.owner_group_id AND g.status='active'
            LEFT JOIN iam_group_memberships m ON m.group_id=g.group_id AND m.principal_id=? AND m.status='active'
            WHERE (b.owner_type='personal' AND b.owner_principal_id=?) OR (b.owner_type='group' AND m.principal_id IS NOT NULL)
            ORDER BY b.workspace_id""",(principal_id,principal_id)).fetchall()
        grants=[]
        for binding in rows:
            if is_api and binding['workspace_id']!=row['workspace_id']:
                continue
            grants.append(WorkspaceGrant(binding['workspace_id'],binding['role'] if binding['owner_type']=='group' else 'personal',
                                         binding['owner_group_id'],binding['policy_revision'] or 0,binding['membership_etag'] or 0,binding['binding_revision']))
        fingerprint=content_hash({'project_id':DEFAULT_PROJECT_ID,'principal_id':principal_id,'auth_version':row['current_auth_version'],
                                  'credential_id':row['credential_id'] if is_api else row['session_id'],
                                  'capabilities':sorted(capabilities),'grants':[list(g.__dict__.values()) for g in grants]})
        return AccessScope(principal_id,tuple(g.workspace_id for g in grants),tuple(grants),capabilities,fingerprint)

    def scope(self, credential):
        with self.control.read_transaction() as con:
            return self._scope(con,credential)

    def _workspace(self, scope, workspace_id, capability):
        if capability not in CAPABILITIES:
            raise ValueError('unknown capability')
        grant=next((g for g in scope.grants if g.workspace_id==workspace_id),None)
        if grant is None or capability not in scope.capabilities or capability not in ROLE_CAPABILITIES[grant.role]:
            raise Forbidden('workspace capability is not granted')
        return grant

    def _authorize(self, con, credential, workspace_id, capability, resource_kind, resource_id):
        return self._authorize_scope(con,self._scope(con,credential),workspace_id,capability,resource_kind,resource_id)

    def _authorize_scope(self,con,scope,workspace_id,capability,resource_kind,resource_id):
        if resource_kind not in RESOURCE_KINDS:
            raise ValueError('unknown authorization root')
        grant=self._workspace(scope,workspace_id,capability)
        resource=con.execute('SELECT * FROM iam_resource_access WHERE workspace_id=? AND resource_kind=? AND resource_id=?',(workspace_id,resource_kind,resource_id)).fetchone()
        if resource is None:
            raise Forbidden('resource is not mapped to an authorization root')
        if resource_kind=='trace' and con.execute('SELECT 1 FROM schema_meta WHERE version=10').fetchone():
            protected=con.execute('SELECT owner_principal_id FROM experiment_judge_traces WHERE workspace_id=? AND trace_id=?',(workspace_id,resource_id)).fetchone()
            if protected and protected['owner_principal_id']!=scope.principal_id:raise Forbidden('Judge Trace requires its private evaluation owner')
        if resource_kind=='trace' and con.execute('SELECT 1 FROM schema_meta WHERE version=11').fetchone():
            protected=con.execute('SELECT owner_principal_id FROM diagnosis_judge_traces WHERE workspace_id=? AND trace_id=?',(workspace_id,resource_id)).fetchone()
            if protected and protected['owner_principal_id']!=scope.principal_id:raise Forbidden('Judge Trace requires its private diagnosis owner')
        own=resource['owner_principal_id']==scope.principal_id
        privileged=grant.role in {'owner','admin','personal'}
        shared=resource['visibility']=='group' or con.execute('SELECT 1 FROM iam_resource_grants WHERE workspace_id=? AND resource_kind=? AND resource_id=? AND grantee_principal_id=?',(workspace_id,resource_kind,resource_id,scope.principal_id)).fetchone() is not None
        if not privileged and not own and not (capability=='read' and shared):
            raise Forbidden('resource access is not granted')
        return scope

    def authorize(self, credential, workspace_id, capability, resource_kind, resource_id):
        with self.control.read_transaction() as con:
            return self._authorize(con,credential,workspace_id,capability,resource_kind,resource_id)

    def _touch_policy(self, con, workspace_id):
        con.execute('UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=(SELECT owner_group_id FROM iam_workspace_bindings WHERE workspace_id=?)',(workspace_id,))
        con.execute("UPDATE iam_workspace_bindings SET binding_revision=binding_revision+1,updated_at_ms=? WHERE workspace_id=? AND owner_type='personal'",(self.clock(),workspace_id))

    def _record_resource(self, con, workspace_id, resource_kind, resource_id, owner_principal_id, visibility, *, invalidate_policy=True):
        if resource_kind not in RESOURCE_KINDS or visibility not in {'private','group'}:
            raise ValueError('invalid resource access record')
        if type(invalidate_policy) is not bool or (not invalidate_policy and visibility!='private'):
            raise ValueError('only new private resources may preserve the policy revision')
        identifier(resource_id)
        now=self.clock()
        con.execute('INSERT INTO iam_resource_access VALUES(?,?,?,?,?,1,?,?)',(workspace_id,resource_kind,resource_id,owner_principal_id,visibility,now,now))
        if invalidate_policy:
            self._touch_policy(con,workspace_id)

    def record_resource_for_provisioning(self, workspace_id, resource_kind, resource_id, owner_principal_id, *, visibility='private'):
        with self.control.transaction() as con:
            self._record_resource(con,workspace_id,resource_kind,resource_id,owner_principal_id,visibility)

    def share_resource(self, credential, workspace_id, resource_kind, resource_id, grantee_principal_id):
        with self.control.transaction() as con:
            scope=self._authorize(con,credential,workspace_id,'write',resource_kind,resource_id)
            row=con.execute('SELECT b.owner_type,b.owner_principal_id,m.status,p.status AS principal_status FROM iam_workspace_bindings b JOIN iam_principals p ON p.principal_id=? LEFT JOIN iam_group_memberships m ON m.group_id=b.owner_group_id AND m.principal_id=p.principal_id WHERE b.workspace_id=?',(grantee_principal_id,workspace_id)).fetchone()
            if not row or row['principal_status']!='active' or (row['owner_type']=='group' and row['status']!='active') or (row['owner_type']=='personal' and row['owner_principal_id']!=grantee_principal_id):
                raise Forbidden('recipient must have current access to the workspace')
            old=con.execute('SELECT 1 FROM iam_resource_grants WHERE workspace_id=? AND resource_kind=? AND resource_id=? AND grantee_principal_id=?',(workspace_id,resource_kind,resource_id,grantee_principal_id)).fetchone()
            if not old:
                con.execute('INSERT INTO iam_resource_grants VALUES(?,?,?,?,?)',(workspace_id,resource_kind,resource_id,grantee_principal_id,self.clock()))
                self._touch_policy(con,workspace_id)
            return scope.principal_id

    def unshare_resource(self, credential, workspace_id, resource_kind, resource_id, grantee_principal_id):
        with self.control.transaction() as con:
            self._authorize(con,credential,workspace_id,'write',resource_kind,resource_id)
            result=con.execute('DELETE FROM iam_resource_grants WHERE workspace_id=? AND resource_kind=? AND resource_id=? AND grantee_principal_id=?',(workspace_id,resource_kind,resource_id,grantee_principal_id))
            if result.rowcount:
                self._touch_policy(con,workspace_id)

    def issue_api_credential(self, credential, workspace_id, capabilities, *, ttl_ms=86_400_000):
        capabilities=_capabilities(capabilities)
        if type(ttl_ms) is not int or not 0<ttl_ms<=31_536_000_000:
            raise ValueError('API credential TTL must be 1ms..365d')
        if 'members' in capabilities:
            raise Forbidden('API credentials cannot manage group membership')
        with self.control.transaction() as con:
            scope=self._scope(con,credential)
            if credential.startswith('api_'):
                raise Forbidden('only a login session may issue API credentials')
            for capability in capabilities:
                self._workspace(scope,workspace_id,capability)
            auth_version=con.execute('SELECT auth_version FROM iam_principals WHERE principal_id=?',(scope.principal_id,)).fetchone()[0]
            token='api_'+secrets.token_urlsafe(32)
            now=self.clock()
            con.execute('INSERT INTO iam_api_credentials VALUES(?,?,?,?,?,?,?,?,NULL)',
                        (str(uuid.uuid4()),scope.principal_id,workspace_id,hashlib.sha256(token.encode()).hexdigest(),canonical_json(sorted(capabilities)),auth_version,now,now+ttl_ms))
            return token

    def revoke_credential(self, credential):
        with self.control.transaction() as con:
            self._authenticate(con,credential)
            is_api=credential.startswith('api_')
            table='iam_api_credentials' if is_api else 'iam_sessions'
            column='token_hash' if is_api else 'session_token_hash'
            con.execute(f'UPDATE {table} SET revoked_at_ms=CASE WHEN issued_at_ms>? THEN issued_at_ms ELSE ? END WHERE {column}=?',(self.clock(),self.clock(),hashlib.sha256(credential.encode()).hexdigest()))
