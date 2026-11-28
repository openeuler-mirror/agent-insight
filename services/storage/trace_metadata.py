import datetime
import json
import re
import uuid

from .contracts import identifier, revision
from .control import Conflict
from .iam import IAMStore, Forbidden


class TraceMetadata:
    def __init__(self,control):
        self.control=control;self.iam=IAMStore(control)

    @staticmethod
    def _alias(value):
        if not isinstance(value,str) or not value or '\x00' in value:raise ValueError('nonempty legacy identity required')
        value.encode('utf-8')
        return value

    def _trace(self,con,token,ws,trace,capability='read',*,allow_retired=False):
        identifier(ws);identifier(trace)
        scope=self.iam._authorize(con,token,ws,capability,'trace',trace)
        row=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if row is None or (not allow_retired and row['state']!='active'):raise Forbidden('Trace route is not active')
        if capability in ('write','delete'):
            grant=self.iam._workspace(scope,ws,capability)
            owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()[0]
            if owner!=scope.principal_id and grant.role not in ('owner','admin','personal'):raise Forbidden('Trace owner required')
        return scope,row

    def register_aliases_for_provisioning(self,ws,trace_id,*,task_id=None,execution_id=None):
        identifier(ws);identifier(trace_id)
        aliases=[(kind,self._alias(value)) for kind,value in [('task',task_id),('execution',execution_id)] if value is not None]
        with self.control.transaction(('trace', ws)) as con:
            if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchone() is None:raise Conflict('Trace route does not exist')
            for kind,alias in aliases:
                old=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(ws,kind,alias)).fetchone()
                if old:
                    if old[0]!=trace_id:raise Conflict('legacy identity already maps to another Trace')
                    continue
                collision=con.execute('SELECT trace_id FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,alias)).fetchone()
                if collision and collision[0]!=trace_id:raise Conflict('legacy identity collides with an internal Trace ID')
                last=con.execute('SELECT MAX(created_at_ms) FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind=?',(ws,trace_id,kind)).fetchone()[0]
                now=max(self.control.clock(),last+1 if last is not None else 0)
                con.execute('INSERT INTO trace_legacy_ids VALUES(?,?,?,?,?)',(ws,kind,alias,trace_id,now))

    def resolve(self,token,ws,ref,kind='task'):
        identifier(ws);self._alias(ref)
        if kind not in ('task','execution'):raise ValueError('invalid legacy identity kind')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
            alias=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(ws,kind,ref)).fetchone()
            trace=alias[0] if alias else ref
            self._trace(con,token,ws,trace)
            result={'trace_id':trace}
            for alias_kind,key in [('task','task_id'),('execution','execution_id')]:
                row=con.execute('SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind=? ORDER BY created_at_ms,alias_id LIMIT 1',(ws,trace,alias_kind)).fetchone()
                result[key]=row[0] if row else trace
            return result

    @staticmethod
    def _properties(row,ws,trace):
        result=dict(row) if row else dict(workspace_id=ws,trace_id=trace,label=None,query_override=None,final_result_override=None,
            feedback_json=None,extra_json='{}',revision=0,created_at_ms=None,updated_at_ms=None)
        extra=json.loads(result['extra_json'])
        result['override_fields']=list(extra.get('override_fields',[]))
        result['query']=result['query_override'];result['final_result']=result['final_result_override']
        result['user_feedback']=json.loads(result['feedback_json']) if result['feedback_json'] is not None else None
        return result

    def properties(self,token,ws,trace_id):
        with self.control.read_transaction() as con:
            self._trace(con,token,ws,trace_id)
            row=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchone()
            return self._properties(row,ws,trace_id)

    def _patch(self,con,token,ws,trace_id,changes,expected_revision=None,*,extra_changes=None):
        if not isinstance(changes,dict) or not changes or set(changes)-{'label','query','final_result','user_feedback'}:raise ValueError('invalid annotation changes')
        encoded=json.dumps(changes,ensure_ascii=False,allow_nan=False,separators=(',',':'))
        if len(encoded.encode())>4*1024*1024:raise ValueError('annotation changes exceed4MiB')
        if expected_revision is not None and (type(expected_revision) is not int or not 0<=expected_revision<=2**63-1):raise ValueError('invalid annotation revision')
        values={}
        for key,value in changes.items():
            if key=='user_feedback':values['feedback_json']=None if value is None else json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':'))
            else:
                if value is not None and not isinstance(value,str):raise ValueError('annotation text must be string or null')
                values[{'query':'query_override','final_result':'final_result_override'}.get(key,key)]=value
        self._trace(con,token,ws,trace_id,'write')
        old=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchone()
        current=self._properties(old,ws,trace_id)
        if expected_revision is not None and expected_revision!=current['revision']:raise Conflict('annotation revision changed')
        extra=json.loads(current['extra_json'])
        if old and set(changes)<=set(current['override_fields']) and all(old[key]==value for key,value in values.items()) and (not extra_changes or all(extra.get(key)==value for key,value in extra_changes.items())):return current
        if extra_changes:extra.update(extra_changes)
        updated=dict(current);updated.update(values);now=self.control.clock()
        extra['override_fields']=sorted(set(current['override_fields'])|set(changes))
        extra_json=json.dumps(extra,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':'))
        version=revision(current['revision']+1)
        if old:
            con.execute('UPDATE trace_annotations SET label=?,query_override=?,final_result_override=?,feedback_json=?,extra_json=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND trace_id=? AND revision=?',
                (updated['label'],updated['query_override'],updated['final_result_override'],updated['feedback_json'],extra_json,version,max(now,old['updated_at_ms']),ws,trace_id,current['revision']))
        else:
            con.execute('INSERT INTO trace_annotations VALUES(?,?,?,?,?,?,?,1,?,?)',(ws,trace_id,updated['label'],updated['query_override'],updated['final_result_override'],updated['feedback_json'],extra_json,now,now))
        return self._properties(con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchone(),ws,trace_id)

    def patch(self,token,ws,trace_id,changes,expected_revision=None):
        with self.control.transaction(('trace', ws, trace_id)) as con:
            return self._patch(con,token,ws,trace_id,changes,expected_revision)

    def delete(self,token,ws,trace_id):
        with self.control.transaction(('trace', ws, trace_id), ('collector', ws, trace_id)) as con:return self._delete(con,token,ws,trace_id)

    def _delete(self,con,token,ws,trace_id):
        scope,locator=self._trace(con,token,ws,trace_id,'delete',allow_retired=True)
        if locator['state']!='active':return False
        if locator['source_namespace']=='collector.source.v1':
            from .collector_graphs import cancel_reserved_graph
            cancel_reserved_graph(self.control,con,ws,trace_id)
        last=con.execute('SELECT MAX(revision) FROM obs_entity_heads WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchone()[0] or 0
        barrier=revision(max(last,locator['route_epoch'])+1);now=self.control.clock()
        con.execute("UPDATE trace_locators SET state='deleting',route_epoch=?,updated_at_ms=? WHERE workspace_id=? AND trace_id=?",(revision(locator['route_epoch']+1),max(now,locator['updated_at_ms']),ws,trace_id))
        existing=con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(ws,trace_id,locator['incarnation'])).fetchone()
        if not existing:con.execute('INSERT INTO deletion_requests VALUES(?,?,?,?,?,?,\'requested\',?,?,?)',(ws,str(uuid.uuid4()),'trace',trace_id,locator['incarnation'],barrier,scope.principal_id,now,now))
        return True

    def _scope(self,con,token,ws,capability='read'):
        identifier(ws);scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,capability)
        return scope,grant

    @staticmethod
    def _privileged(grant):return grant.role in ('owner','admin','personal')

    def _counts(self,con,scope,grant,ws):
        if 'read' not in scope.capabilities:return {}
        params=[ws];access=''
        if not self._privileged(grant):
            access=" AND (a.owner_principal_id=? OR a.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=a.workspace_id AND g.resource_kind=a.resource_kind AND g.resource_id=a.resource_id AND g.grantee_principal_id=?))"
            params.extend([scope.principal_id,scope.principal_id])
        rows=con.execute("""SELECT l.tag_id,COUNT(*) AS n FROM trace_tag_links l
            JOIN trace_locators t ON t.workspace_id=l.workspace_id AND t.trace_id=l.trace_id AND t.state='active'
            JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id
            WHERE l.workspace_id=?"""+access+' GROUP BY l.tag_id',tuple(params))
        return {row['tag_id']:row['n'] for row in rows}

    @staticmethod
    def _dto(row,count=0):
        return {'id':row['tag_id'],'name':row['name'],'description':row['description'],'kind':row['kind'],'color':row['color'],
            'createdBy':row['login_name'],'createdAt':datetime.datetime.fromtimestamp(row['created_at_ms']/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
            'usageCount':count,'revision':row['revision']}

    def _tag_rows(self,con,ws,*,kind=None,trace_id=None):
        sql='SELECT t.*,p.normalized_login_name AS login_name FROM trace_tags t JOIN iam_principals p ON p.principal_id=t.owner_principal_id'
        params=[ws]
        if trace_id is not None:
            sql+=' JOIN trace_tag_links l ON l.workspace_id=t.workspace_id AND l.tag_id=t.tag_id'
        sql+=' WHERE t.workspace_id=?'
        if trace_id is not None:sql+=' AND l.trace_id=?';params.append(trace_id)
        if kind is not None:sql+=' AND t.kind=?';params.append(kind)
        return con.execute(sql+' ORDER BY t.created_at_ms DESC,t.tag_id',tuple(params)).fetchall()

    def list_tags(self,token,ws,kind=None):
        if kind not in (None,'version','business'):raise ValueError('invalid tag kind')
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws);counts=self._counts(con,scope,grant,ws)
            return [self._dto(row,counts.get(row['tag_id'],0)) for row in self._tag_rows(con,ws,kind=kind)
                if self._privileged(grant) or row['owner_principal_id']==scope.principal_id or counts.get(row['tag_id'],0)]

    @staticmethod
    def _tag_fields(payload,old=None):
        if not isinstance(payload,dict) or set(payload)-{'user','name','description','kind','color'}:raise ValueError('invalid tag fields')
        fields=dict(old) if old else dict(kind='version',color='#6366f1',description=None)
        for key,value in payload.items():
            if key=='user':continue
            fields[key]=value
        name=fields.get('name')
        if not isinstance(name,str) or not name.strip() or len(name.strip())>80:raise ValueError('tag name must contain1..80 characters')
        fields['name']=name.strip()
        if fields['kind'] not in ('version','business'):raise ValueError('invalid tag kind')
        desc=fields['description']
        if desc is not None and not isinstance(desc,str):raise ValueError('invalid tag description')
        fields['description']=desc.strip()[:300] or None if desc is not None else None
        color=fields['color']
        fields['color']=color.lower() if isinstance(color,str) and re.fullmatch('#[0-9a-fA-F]{6}',color) else '#6366f1'
        return fields

    def _tag(self,con,scope,grant,ws,tag_id):
        identifier(tag_id)
        row=con.execute('SELECT t.*,p.normalized_login_name AS login_name FROM trace_tags t JOIN iam_principals p ON p.principal_id=t.owner_principal_id WHERE t.workspace_id=? AND t.tag_id=?',(ws,tag_id)).fetchone()
        if row is None:raise Forbidden('tag is not available')
        if row['owner_principal_id']!=scope.principal_id and not self._privileged(grant):raise Forbidden('tag owner required')
        return row

    def create_tag(self,token,ws,payload):
        fields=self._tag_fields(payload)
        with self.control.transaction(('tag', ws)) as con:
            scope,grant=self._scope(con,token,ws,'write');now=self.control.clock();tag_id=str(uuid.uuid4())
            con.execute('INSERT INTO trace_tags VALUES(?,?,?,?,?,?,?,1,?,?)',(ws,tag_id,scope.principal_id,fields['kind'],fields['name'],fields['description'],fields['color'],now,now))
            row=self._tag(con,scope,grant,ws,tag_id)
            return self._dto(row)

    def update_tag(self,token,ws,tag_id,payload,expected_revision=None):
        if expected_revision is not None:revision(expected_revision)
        with self.control.transaction(('tag', ws, tag_id)) as con:
            scope,grant=self._scope(con,token,ws,'write');row=self._tag(con,scope,grant,ws,tag_id)
            if expected_revision is not None and row['revision']!=expected_revision:raise Conflict('tag revision changed')
            fields=self._tag_fields(payload,row)
            keys=('kind','name','description','color')
            if any(fields[k]!=row[k] for k in keys):
                con.execute('UPDATE trace_tags SET kind=?,name=?,description=?,color=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND tag_id=? AND revision=?',
                    (fields['kind'],fields['name'],fields['description'],fields['color'],revision(row['revision']+1),max(self.control.clock(),row['updated_at_ms']),ws,tag_id,row['revision']))
            row=self._tag(con,scope,grant,ws,tag_id);counts=self._counts(con,scope,grant,ws)
            return self._dto(row,counts.get(tag_id,0))

    def delete_tag(self,token,ws,tag_id):
        identifier(tag_id)
        with self.control.transaction(('tag', ws, tag_id), ('trace', ws)) as con:
            scope,grant=self._scope(con,token,ws,'delete')
            exists=con.execute('SELECT 1 FROM trace_tags WHERE workspace_id=? AND tag_id=?',(ws,tag_id)).fetchone()
            if not exists:return False
            self._tag(con,scope,grant,ws,tag_id)
            con.execute('DELETE FROM trace_tag_links WHERE workspace_id=? AND tag_id=?',(ws,tag_id))
            con.execute('DELETE FROM trace_tags WHERE workspace_id=? AND tag_id=?',(ws,tag_id))
            return True

    def _linked(self,con,scope,grant,ws,trace):
        counts=self._counts(con,scope,grant,ws)
        return [self._dto(row,counts.get(row['tag_id'],0)) for row in self._tag_rows(con,ws,trace_id=trace)]

    def get_trace_tags(self,token,ws,trace_id):
        with self.control.read_transaction() as con:
            scope,_=self._trace(con,token,ws,trace_id);grant=self.iam._workspace(scope,ws,'read')
            return self._linked(con,scope,grant,ws,trace_id)

    @staticmethod
    def _tag_ids(values):
        if not isinstance(values,list) or len(values)>1000:raise ValueError('tag IDs must be bounded list')
        return sorted({identifier(value) for value in values})

    def _links(self,token,ws,trace_id,tag_ids,mode):
        tag_ids=self._tag_ids(tag_ids)
        with self.control.transaction(('trace', ws, trace_id), *[('tag', ws, tag) for tag in tag_ids]) as con:
            scope,_=self._trace(con,token,ws,trace_id,'write');grant=self.iam._workspace(scope,ws,'write')
            if mode!='remove':
                for tag in tag_ids:self._tag(con,scope,grant,ws,tag)
            if mode=='replace':
                existing=con.execute('SELECT tag_id FROM trace_tag_links WHERE workspace_id=? AND trace_id=?',(ws,trace_id)).fetchall()
                for row in existing:
                    if row[0] not in tag_ids:con.execute('DELETE FROM trace_tag_links WHERE workspace_id=? AND trace_id=? AND tag_id=?',(ws,trace_id,row[0]))
            if mode=='remove':
                for tag in tag_ids:con.execute('DELETE FROM trace_tag_links WHERE workspace_id=? AND trace_id=? AND tag_id=?',(ws,trace_id,tag))
            else:
                for tag in tag_ids:
                    if con.execute('SELECT 1 FROM trace_tag_links WHERE workspace_id=? AND trace_id=? AND tag_id=?',(ws,trace_id,tag)).fetchone() is None:
                        con.execute('INSERT INTO trace_tag_links VALUES(?,?,?,?,?)',(ws,trace_id,tag,scope.principal_id,self.control.clock()))
            return self._linked(con,scope,grant,ws,trace_id)

    def replace_trace_tags(self,token,ws,trace_id,tag_ids):return self._links(token,ws,trace_id,tag_ids,'replace')
    def add_trace_tags(self,token,ws,trace_id,tag_ids):return self._links(token,ws,trace_id,tag_ids,'add')
    def remove_trace_tags(self,token,ws,trace_id,tag_ids):return self._links(token,ws,trace_id,tag_ids,'remove')
    def remove_trace_tag(self,token,ws,trace_id,tag_id):return self.remove_trace_tags(token,ws,trace_id,[tag_id])
