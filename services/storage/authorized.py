import datetime
import hashlib
from pathlib import Path

from .contracts import identifier
from .iam import Forbidden, RESOURCE_KINDS
from .projects import default_project_id, resolve_project


RESOURCE_TABLES = {
    'trace': ('trace_locators','trace_id'),
    'asset': ('asset_identities','asset_id'),
    'run': ('runs','run_id'),
    'snapshot': ('snapshot_manifests','snapshot_id'),
    'artifact': ('artifact_metadata','artifact_id'),
}


class AuthorizedStorage:
    def __init__(self, iam, facts, *, project_id=None):
        self.project_id=default_project_id(project_id)
        self.iam=iam
        self.control=iam.control
        self.facts=facts

    def project_context(self, credential, workspace_id):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential)
            self.iam._workspace(scope,workspace_id,'read')
            return resolve_project(con,workspace_id,self.project_id)

    def create_trace(self, credential, workspace_id, trace_id, bucket, *, source_namespace, native_trace_id):
        datetime.date.fromisoformat(bucket)
        for value in (workspace_id,trace_id,source_namespace,native_trace_id): identifier(value)
        now=self.control.clock()
        with self.control.transaction() as con:
            scope=self.iam._scope(con,credential)
            self.iam._workspace(scope,workspace_id,'write')
            con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',
                        (workspace_id,trace_id,source_namespace,native_trace_id,bucket,now,now))
            self.iam._record_resource(con,workspace_id,'trace',trace_id,scope.principal_id,'private')
        return trace_id

    def _trace(self, con, credential, workspace_id, bucket, trace_id, capability='read'):
        scope=self.iam._authorize(con,credential,workspace_id,capability,'trace',trace_id)
        locator=con.execute("SELECT trace_bucket FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,trace_id)).fetchone()
        if not locator or locator[0]!=bucket:
            raise Forbidden('Trace route is not active in the authorized workspace and bucket')
        return scope

    def _trace_read(self, credential, workspace_id, bucket, trace_id, method, *args, **options):
        with self.control.read_transaction() as con:
            self._trace(con,credential,workspace_id,bucket,trace_id)
        result=getattr(self.facts,method)(workspace_id,bucket,trace_id,*args,**options)
        with self.control.read_transaction() as con:
            self._trace(con,credential,workspace_id,bucket,trace_id)
        return result

    def read_span(self, credential, workspace_id, bucket, trace_id, span_id):
        return self._trace_read(credential,workspace_id,bucket,trace_id,'read_span',span_id)

    def read_spans(self, credential, workspace_id, bucket, trace_id, **options):
        return self._trace_read(credential,workspace_id,bucket,trace_id,'read_spans',**options)

    def read_payload(self, credential, workspace_id, bucket, trace_id, span_id, payload_revision, section, **options):
        return self._trace_read(credential,workspace_id,bucket,trace_id,'read_payload',span_id,payload_revision,section,**options)

    def write_spans(self, credential, rows):
        if not isinstance(rows,list) or not 1<=len(rows)<=4096:
            raise ValueError('span batch must contain 1..4096 rows')
        roots={(row['workspace_id'],row['trace_bucket'],row['trace_id']) for row in rows}
        with self.control.read_transaction() as con:
            for workspace_id,bucket,trace_id in sorted(roots):
                self._trace(con,credential,workspace_id,bucket,trace_id,'write')
        return self.facts.write_spans(rows)

    def write_payload_bundle(self, credential, workspace_id, bucket, trace_id, span_id, sections):
        with self.control.read_transaction() as con:
            self._trace(con,credential,workspace_id,bucket,trace_id,'write')
        return self.facts.write_payload_bundle(workspace_id,bucket,trace_id,span_id,sections)

    def _summary_scope(self, credential, workspace_ids, bucket_from, bucket_to, trace_ids):
        if not isinstance(workspace_ids,(tuple,list)) or not 1<=len(workspace_ids)<=1000 or len(set(workspace_ids))!=len(workspace_ids):
            raise Forbidden('an explicit nonempty bounded workspace selection is required')
        if trace_ids is not None and (not isinstance(trace_ids,dict) or set(trace_ids)!=set(workspace_ids)):
            raise Forbidden('each selected workspace requires an explicit Trace selection')
        start=datetime.date.fromisoformat(bucket_from)
        end=datetime.date.fromisoformat(bucket_to)
        if start>end:
            raise ValueError('invalid bucket range')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential)
            excluded={}
            for workspace_id in workspace_ids:
                grant=self.iam._workspace(scope,workspace_id,'read')
                if trace_ids is None:
                    if grant.role not in {'owner','admin','personal'}:
                        raise Forbidden('member analytics requires explicit authorized Trace roots')
                else:
                    roots=trace_ids[workspace_id]
                    if not isinstance(roots,(tuple,list)) or not 1<=len(roots)<=1000:
                        raise Forbidden('Trace selection must contain 1..1000 identifiers per workspace')
                    for trace_id in roots:
                        locator=con.execute("SELECT trace_bucket FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,trace_id)).fetchone()
                        if not locator:
                            raise Forbidden('Trace route is not active')
                        self._trace(con,credential,workspace_id,locator[0],trace_id)
                inactive=con.execute("SELECT trace_id FROM trace_locators WHERE workspace_id=? AND trace_bucket>=? AND trace_bucket<=? AND state<>'active' ORDER BY trace_id LIMIT 1001",(workspace_id,bucket_from,bucket_to)).fetchall()
                if len(inactive)>1000:
                    raise Forbidden('analytics deletion barrier exceeds bounded scope; narrow the date range')
                hidden={row[0] for row in inactive}
                if con.execute('SELECT 1 FROM schema_meta WHERE version=10').fetchone():
                    protected=con.execute('SELECT j.trace_id FROM experiment_judge_traces j JOIN trace_locators t ON t.workspace_id=j.workspace_id AND t.trace_id=j.trace_id WHERE j.workspace_id=? AND j.owner_principal_id<>? AND t.trace_bucket>=? AND t.trace_bucket<=? LIMIT 1001',(workspace_id,scope.principal_id,bucket_from,bucket_to)).fetchall()
                    hidden.update(row[0] for row in protected)
                if con.execute('SELECT 1 FROM schema_meta WHERE version=11').fetchone():
                    protected=con.execute('SELECT j.trace_id FROM diagnosis_judge_traces j JOIN trace_locators t ON t.workspace_id=j.workspace_id AND t.trace_id=j.trace_id WHERE j.workspace_id=? AND j.owner_principal_id<>? AND t.trace_bucket>=? AND t.trace_bucket<=? LIMIT 1001',(workspace_id,scope.principal_id,bucket_from,bucket_to)).fetchall()
                    hidden.update(row[0] for row in protected)
                if len(hidden)>1000:raise Forbidden('analytics privacy/deletion barrier exceeds bounded scope; narrow the date range')
                if hidden:excluded[workspace_id]=sorted(hidden)
            return scope,excluded

    def summarize_spans(self, credential, workspace_ids, bucket_from, bucket_to, *, trace_ids=None):
        scope,excluded=self._summary_scope(credential,workspace_ids,bucket_from,bucket_to,trace_ids)
        result=self.facts.summarize_spans(list(workspace_ids),bucket_from,bucket_to,trace_ids=trace_ids,excluded_trace_ids=excluded)
        current,current_excluded=self._summary_scope(credential,workspace_ids,bucket_from,bucket_to,trace_ids)
        if current.fingerprint!=scope.fingerprint or current_excluded!=excluded:
            raise Forbidden('authorization or deletion scope changed during analytics; retry')
        return dict(result,project_id=scope.project_id,scope_fingerprint=scope.fingerprint)

    def read_resource(self, credential, workspace_id, resource_kind, resource_id):
        if resource_kind not in RESOURCE_KINDS:
            raise ValueError('unknown authorization root')
        table,key=RESOURCE_TABLES[resource_kind]
        with self.control.read_transaction() as con:
            self.iam._authorize(con,credential,workspace_id,'read',resource_kind,resource_id)
            row=con.execute(f'SELECT * FROM {table} WHERE workspace_id=? AND {key}=?',(workspace_id,resource_id)).fetchone()
            if row is None:
                raise Forbidden('resource is not available')
            if resource_kind=='trace' and row['state']!='active':
                raise Forbidden('Trace route is not active')
            if resource_kind=='artifact' and row['namespace'] not in {'public','trace','result','report','attachment'}:
                raise Forbidden('artifact namespace requires a separate evaluation protocol')
            return dict(row)

    def list_resources(self, credential, workspace_id, resource_kind, *, after_id='', limit=100):
        if resource_kind not in RESOURCE_KINDS or type(limit) is not int or not 1<=limit<=1000:
            raise ValueError('invalid bounded resource query')
        table,key=RESOURCE_TABLES[resource_kind]
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential)
            grant=self.iam._workspace(scope,workspace_id,'read')
            parameters=[workspace_id,resource_kind,after_id]
            access=''
            if grant.role not in {'owner','admin','personal'}:
                access=" AND (a.owner_principal_id=? OR a.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=a.workspace_id AND g.resource_kind=a.resource_kind AND g.resource_id=a.resource_id AND g.grantee_principal_id=?))"
                parameters.extend([scope.principal_id,scope.principal_id])
            if resource_kind=='trace':
                access+=" AND t.state='active'"
                if con.execute('SELECT 1 FROM schema_meta WHERE version=10').fetchone():
                    access+=' AND NOT EXISTS(SELECT 1 FROM experiment_judge_traces j WHERE j.workspace_id=t.workspace_id AND j.trace_id=t.trace_id AND j.owner_principal_id<>?)'
                    parameters.append(scope.principal_id)
                if con.execute('SELECT 1 FROM schema_meta WHERE version=11').fetchone():
                    access+=' AND NOT EXISTS(SELECT 1 FROM diagnosis_judge_traces j WHERE j.workspace_id=t.workspace_id AND j.trace_id=t.trace_id AND j.owner_principal_id<>?)'
                    parameters.append(scope.principal_id)
            if resource_kind=='artifact':
                access+=" AND t.namespace IN ('public','trace','result','report','attachment')"
            parameters.append(limit)
            rows=con.execute(f'SELECT t.* FROM {table} t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_id=t.{key} WHERE a.workspace_id=? AND a.resource_kind=? AND t.{key}>?'+access+f' ORDER BY t.{key} LIMIT ?',tuple(parameters)).fetchall()
            return {'items':[dict(row) for row in rows],'project_id':scope.project_id,'scope_fingerprint':scope.fingerprint}

    def read_artifact(self, credential, workspace_id, artifact_id):
        with self.control.read_transaction() as con:
            self.iam._authorize(con,credential,workspace_id,'read','artifact',artifact_id)
            row=con.execute("SELECT * FROM artifact_metadata WHERE workspace_id=? AND artifact_id=? AND state='published'",(workspace_id,artifact_id)).fetchone()
            if row is None or row['namespace'] not in {'public','trace','result','report','attachment'}:
                raise Forbidden('artifact is not published in an allowed namespace')
            if row['size_bytes']>16*1024*1024:
                raise ValueError('artifact exceeds bounded download size; use a separately authorized streaming port')
            metadata=dict(row)
        target=Path(metadata['object_ref'])
        if target.stat().st_size!=metadata['size_bytes']:
            raise ValueError('artifact size does not match metadata')
        self.control._verify_artifact(metadata['content_hash'],metadata['object_ref'])
        with target.open('rb') as source:
            body=source.read(16*1024*1024+1)
        if len(body)!=metadata['size_bytes'] or hashlib.sha256(body).hexdigest()!=metadata['content_hash']:
            raise ValueError('artifact bytes do not match metadata')
        with self.control.read_transaction() as con:
            self.iam._authorize(con,credential,workspace_id,'read','artifact',artifact_id)
            current=con.execute('SELECT * FROM artifact_metadata WHERE workspace_id=? AND artifact_id=?',(workspace_id,artifact_id)).fetchone()
            if not current or current['state']!='published' or current['namespace'] not in {'public','trace','result','report','attachment'} or any(current[key]!=metadata[key] for key in ('object_ref','content_hash','size_bytes')):
                raise Forbidden('artifact availability changed during download')
        return body
