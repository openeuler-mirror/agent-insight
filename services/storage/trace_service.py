import base64
import hashlib
import hmac
import json
from pathlib import Path

from .contracts import canonical_json, content_hash, identifier
from .control import StorageError
from .iam import IAMStore, Forbidden


class CursorExpired(StorageError):
    pass


class TraceQueries:
    def __init__(self, control, facts, *, cursor_secret):
        if not isinstance(cursor_secret,bytes) or len(cursor_secret)<24:
            raise ValueError('cursor signing secret must contain at least24 bytes')
        self.control=control
        self.facts=facts
        self.iam=IAMStore(control)
        self.secret=cursor_secret

    def _encode(self, value):
        body=canonical_json(value).encode()
        signature=hmac.new(self.secret,body,hashlib.sha256).digest()
        return base64.urlsafe_b64encode(body+signature).decode().rstrip('=')

    def _decode(self, cursor, scope, query):
        try:
            if not isinstance(cursor,str) or not 1<=len(cursor)<=8192:
                raise ValueError()
            raw=base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True)
            if base64.urlsafe_b64encode(raw).decode().rstrip('=')!=cursor:raise ValueError()
            body,signature=raw[:-32],raw[-32:]
            if len(signature)!=32 or not hmac.compare_digest(signature,hmac.new(self.secret,body,hashlib.sha256).digest()):
                raise ValueError()
            value=json.loads(body)
            if value['version']!=1 or value['scope']!=scope or value['query']!=query:
                raise ValueError()
            if type(value['created_at_ms']) is not int or value['created_at_ms']<0:
                raise ValueError()
            identifier(value['trace_id'])
            return value['created_at_ms'],value['trace_id']
        except (ValueError,TypeError,KeyError,UnicodeError):
            raise CursorExpired('pagination scope changed or cursor is invalid; refresh the list') from None

    def _selection(self, con, scope, workspace_id):
        grant=self.iam._workspace(scope,workspace_id,'read')
        params=[workspace_id]
        access=''
        if grant.role not in {'owner','admin','personal'}:
            access=" AND (a.owner_principal_id=? OR a.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=a.workspace_id AND g.resource_kind=a.resource_kind AND g.resource_id=a.resource_id AND g.grantee_principal_id=?))"
            params.extend([scope.principal_id,scope.principal_id])
        return access,params

    def _candidates(self, credential, workspace_id, after, limit):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential)
            access,params=self._selection(con,scope,workspace_id)
            if after is not None:
                access+=' AND (t.created_at_ms<? OR (t.created_at_ms=? AND t.trace_id<?))'
                params.extend([after[0],after[0],after[1]])
            params.append(limit)
            rows=con.execute("""SELECT t.*,a.owner_principal_id,p.display_name AS owner_display_name FROM trace_locators t
                JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id
                JOIN iam_principals p ON p.principal_id=a.owner_principal_id
                WHERE t.workspace_id=? AND t.state='active'"""+access+' ORDER BY t.created_at_ms DESC,t.trace_id DESC LIMIT ?',tuple(params)).fetchall()
            return scope,[dict(r) for r in rows]

    def _trace_rows(self, workspace_id, candidates, *, status, agent, search):
        if not candidates:
            return {}
        params={'workspace_id':workspace_id}
        pairs=[]
        for i,row in enumerate(candidates):
            params['trace_'+str(i)]=row['trace_id']
            params['bucket_'+str(i)]=row['trace_bucket']
            pairs.append('(trace_id={trace_'+str(i)+':String} AND trace_bucket={bucket_'+str(i)+':Date})')
        predicates=['workspace_id={workspace_id:String}','is_deleted=0','('+' OR '.join(pairs)+')']
        if status:
            predicates.append('execution_status={status:String}')
            params['status']=status
        if agent:
            predicates.append('positionCaseInsensitiveUTF8(agent_name,{agent:String})>0')
            params['agent']=agent
        if search:
            predicates.append('positionCaseInsensitiveUTF8(concat(trace_id,\' \',native_trace_id,\' \',agent_name),{search:String})>0')
            params['search']=search
        sql='SELECT * FROM obs_trace_current FINAL WHERE '+' AND '.join(predicates)+' FORMAT JSONEachRow'
        raw=self.facts._request(sql,parameters=params)
        rows=[json.loads(line) for line in raw.splitlines() if line]
        return {(r['trace_bucket'],r['trace_id']):r for r in rows if r['workspace_id']==workspace_id}

    def list_traces(self, credential, workspace_id, *, limit=50, cursor=None, status=None, agent=None, search=None):
        identifier(workspace_id)
        if type(limit) is not int or not 1<=limit<=200:
            raise ValueError('Trace page size must be1..200')
        if status not in (None,'','done','failed','running','unknown'):
            raise ValueError('invalid Trace status')
        for value in (agent,search):
            if value is not None and (not isinstance(value,str) or len(value)>256):
                raise ValueError('invalid bounded Trace filter')
        query=content_hash({'workspace_id':workspace_id,'status':status or '', 'agent':agent or '', 'search':search or ''})
        scope,_=self._candidates(credential,workspace_id,None,1)
        after=self._decode(cursor,scope.fingerprint,query) if cursor else None
        items=[];scanned=0;position=after;exhausted=False
        while len(items)<limit and scanned<2000:
            current,candidates=self._candidates(credential,workspace_id,position,min(200,2000-scanned))
            if current.fingerprint!=scope.fingerprint:
                raise CursorExpired('authorization changed while listing; refresh')
            if not candidates:
                exhausted=True;break
            facts=self._trace_rows(workspace_id,candidates,status=status,agent=agent,search=search)
            for candidate in candidates:
                scanned+=1
                position=(candidate['created_at_ms'],candidate['trace_id'])
                row=facts.get((candidate['trace_bucket'],candidate['trace_id']))
                if row:
                    items.append(dict(row,owner_principal_id=candidate['owner_principal_id'],owner_display_name=candidate['owner_display_name'],created_at_ms=candidate['created_at_ms']))
                    if len(items)==limit:
                        break
        if not exhausted and position is not None:
            _,remaining=self._candidates(credential,workspace_id,position,1)
            exhausted=not remaining
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,credential)
            self.iam._workspace(current,workspace_id,'read')
            if current.fingerprint!=scope.fingerprint:
                raise Forbidden('authorization changed during Trace query')
            for row in items:
                self.iam._authorize(con,credential,workspace_id,'read','trace',row['trace_id'])
                active=con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,row['trace_id'])).fetchone()
                if not active:
                    raise Forbidden('Trace deletion state changed during query')
        next_cursor=None if exhausted or position is None else self._encode({'version':1,'scope':scope.fingerprint,'query':query,'created_at_ms':position[0],'trace_id':position[1]})
        return {'items':items,'next_cursor':next_cursor,'partial':scanned>=2000 and not exhausted,'scanned':scanned,'project_id':scope.project_id}

    def route(self, credential, workspace_id, trace_id):
        with self.control.read_transaction() as con:
            self.iam._authorize(con,credential,workspace_id,'read','trace',trace_id)
            row=con.execute("SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,trace_id)).fetchone()
            if not row:
                raise Forbidden('Trace route is not available')
            return dict(row)

    def summary(self, credential, workspace_id, trace_id):
        route=self.route(credential,workspace_id,trace_id)
        rows=self._trace_rows(workspace_id,[route],status=None,agent=None,search=None)
        row=rows.get((route['trace_bucket'],trace_id))
        with self.control.read_transaction() as con:
            self.iam._authorize(con,credential,workspace_id,'read','trace',trace_id)
            active=con.execute("SELECT trace_bucket FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,trace_id)).fetchone()
            if not active or active[0]!=route['trace_bucket']:raise Forbidden('Trace route changed during query')
            owner=con.execute("SELECT a.owner_principal_id,p.display_name AS owner_display_name FROM iam_resource_access a JOIN iam_principals p ON p.principal_id=a.owner_principal_id WHERE a.workspace_id=? AND a.resource_kind='trace' AND a.resource_id=?",(workspace_id,trace_id)).fetchone()
        return {'trace':dict(row,**dict(owner)),'state':'indexed'} if row else {'trace':None,'state':'accepted'}


class TraceRuntime:
    def __init__(self, control, facts, *, cursor_secret, default_workspace=None):
        import threading
        from .authorized import AuthorizedStorage
        from .observations import ObservationIngest
        self.control=control;self.facts=facts;self.iam=IAMStore(control)
        self.queries=TraceQueries(control,facts,cursor_secret=cursor_secret)
        self.authorized=AuthorizedStorage(self.iam,facts)
        self.ingest=ObservationIngest(control,facts)
        self.default_workspace=default_workspace
        self.stop=threading.Event();self.worker=None;self.last_worker_error=None
        self.login_lock=threading.Lock();self.login_attempts=[]

    def profile(self, token):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token)
            row=con.execute('SELECT normalized_login_name,display_name FROM iam_principals WHERE principal_id=?',(scope.principal_id,)).fetchone()
            workspaces=[]
            for grant in scope.grants:
                name=con.execute('SELECT name FROM workspaces WHERE workspace_id=?',(grant.workspace_id,)).fetchone()[0]
                workspaces.append({'workspace_id':grant.workspace_id,'name':name,'role':grant.role})
            selected=self.default_workspace if self.default_workspace in scope.allowed_workspace_ids else (scope.allowed_workspace_ids[0] if scope.allowed_workspace_ids else '')
            return {'username':row['normalized_login_name'],'principal_id':scope.principal_id,'display_name':row['display_name'],'project_id':scope.project_id,'workspace_id':selected,'workspaces':workspaces}

    def workspace(self, token, explicit, capability):
        scope=self.iam.scope(token)
        selected=explicit or (self.default_workspace if self.default_workspace in scope.allowed_workspace_ids else None)
        if not selected and len(scope.allowed_workspace_ids)==1:selected=scope.allowed_workspace_ids[0]
        if not selected:raise ValueError('an explicit workspace selection is required')
        self.iam._workspace(scope,selected,capability)
        return selected

    def login(self, username, password):
        import time
        now=time.monotonic()
        with self.login_lock:
            self.login_attempts=[stamp for stamp in self.login_attempts if now-stamp<60]
            if len(self.login_attempts)>=60:raise RateLimited('login rate exceeded')
            self.login_attempts.append(now)
        token=self.iam.login(username,password,ttl_ms=86_400_000)
        try:return {'session_token':token,'profile':self.profile(token)}
        except BaseException:
            self.iam.revoke_credential(token)
            raise

    def start_worker(self):
        import threading,uuid
        if self.worker is not None:raise ValueError('worker is already started')
        worker_id='trace-http-'+uuid.uuid4().hex
        def work():
            while not self.stop.is_set():
                try:
                    progressed=self.ingest.work_once(worker_id)
                    self.last_worker_error=None
                except Exception as exc:
                    self.last_worker_error=type(exc).__name__
                    progressed=False
                if not progressed:self.stop.wait(.25)
        self.worker=threading.Thread(target=work,name='trace-materializer',daemon=True);self.worker.start()

    def close(self):
        self.stop.set()
        if self.worker:self.worker.join(timeout=35)


class RateLimited(StorageError):
    pass


def create_server(runtime, *, host='127.0.0.1', port=0):
    import http.server
    import re
    import socketserver
    import threading
    import urllib.parse
    from .control import Conflict
    from .clickhouse import ClickHouseError
    from .iam import Unauthorized

    if host!='127.0.0.1':raise ValueError('Trace service must bind to IPv4 loopback')

    class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):
        daemon_threads=True
        request_queue_size=32
        def __init__(self,*args,**kwargs):
            self.slots=threading.BoundedSemaphore(32)
            super().__init__(*args,**kwargs)
        def process_request(self,request,address):
            if not self.slots.acquire(blocking=False):
                try:request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
                finally:self.shutdown_request(request)
                return
            try:super().process_request(request,address)
            except BaseException:self.slots.release();raise
        def process_request_thread(self,*args):
            try:super().process_request_thread(*args)
            finally:self.slots.release()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def setup(self):
            super().setup();self.connection.settimeout(15)
        def log_message(self,*args):pass
        def reply(self,status,value,*,max_bytes=4*1024*1024):
            raw=json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
            if len(raw)>max_bytes:
                status=413;raw=b'{"error":"Response exceeds bounded page size"}'
            self.send_response(status)
            for name,value in [('Content-Type','application/json; charset=utf-8'),('Content-Length',str(len(raw))),('Cache-Control','no-store'),('Connection','close'),('X-Content-Type-Options','nosniff')]:self.send_header(name,value)
            self.end_headers();self.close_connection=True;self.wfile.write(raw)
        def token(self):
            values=self.headers.get_all('Authorization') or []
            if len(values)!=1 or not re.fullmatch(r'Bearer (session|api)_[A-Za-z0-9_-]{43}',values[0]):raise Unauthorized('Bearer credential required')
            return values[0][7:]
        def body(self,max_bytes=4*1024*1024):
            if self.headers.get('Content-Type','').split(';')[0].strip().lower()!='application/json':
                return None,415
            lengths=self.headers.get_all('Content-Length') or []
            if self.headers.get('Transfer-Encoding') or len(lengths)!=1 or not lengths[0].isdigit():raise ValueError('explicit content length required')
            size=int(lengths[0])
            if size>max_bytes:return None,413
            raw=self.rfile.read(size)
            if len(raw)!=size:raise ValueError('incomplete request')
            value=json.loads(raw.decode('utf-8'),parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite JSON')))
            if not isinstance(value,dict):raise ValueError('JSON object required')
            return value,None
        def run_request(self):
            try:
                self.dispatch()
            except Unauthorized:self.reply(401,{'error':'Authentication required'})
            except Forbidden:self.reply(403,{'error':'Forbidden'})
            except RateLimited:self.reply(429,{'error':'Too many login attempts'})
            except (CursorExpired,Conflict):self.reply(409,{'error':'State conflict; refresh or inspect batch status'})
            except (ValueError,KeyError,TypeError,UnicodeError,RecursionError):self.reply(400,{'error':'Invalid bounded request'})
            except ClickHouseError:self.reply(503,{'error':'Analytical storage unavailable'})
            except Exception as exc:
                status=getattr(exc,'status',503)
                self.reply(status if status in (400,403,404,409,413,503) else 503,{'error':'Storage compatibility request failed' if status!=503 else 'Storage service unavailable'})
        do_GET=run_request
        do_POST=run_request
        do_PUT=run_request
        do_PATCH=run_request
        do_DELETE=run_request
        def dispatch_compat(self,token,pieces,params):
            from .trace_metadata import TraceMetadata
            from .compatibility import LegacyTraceReads
            from .compatibility_list import LegacyTraceList
            compat_path=pieces[2:]
            deleting_root=self.command=='DELETE' and (compat_path==['observe','data'] or (len(compat_path)==2 and compat_path[0]=='tags'))
            workspace=runtime.workspace(token,params.get('workspace_id'),'read' if self.command=='GET' else 'delete' if deleting_root else 'write')
            metadata=TraceMetadata(runtime.control)
            listing=LegacyTraceList(runtime.queries,metadata)
            reads=LegacyTraceReads(runtime.queries,runtime.authorized)
            path=pieces[2:]
            def respond(value,status=200,limit=4*1024*1024):self.reply(status,{'value':value},max_bytes=limit)
            def body():
                value,error=self.body()
                if error:self.reply(error,{'error':'JSON body required or body too large'});return None
                return value
            if path==['observe','evidence'] and self.command=='GET':
                from .trace_evidence import TraceEvidence, MAX_EVIDENCE_BYTES
                evidence=TraceEvidence(runtime.queries,runtime.authorized)
                respond(evidence.read(token,workspace,task_id=params.get('taskId'),execution_id=params.get('executionId')),limit=MAX_EVIDENCE_BYTES+1024);return
            if path[:3]==['observe','traces','import'] and len(path)==3 and self.command=='POST':
                import time
                from .trace_transfer import LegacyTraceTransfer, TraceTransferPending
                value,error=self.body(max_bytes=50*1024*1024)
                if error:self.reply(error,{'error':'JSON bundle required or body too large'});return
                transfer=LegacyTraceTransfer(runtime.control,runtime.queries,runtime.authorized,metadata,runtime.ingest)
                result=transfer.import_bundle(token,workspace,value.get('bundle'),receipt_key=self.headers.get('Idempotency-Key'))
                deadline=time.monotonic()+290
                for batch in result.batch_refs:
                    while True:
                        receipt=runtime.ingest.batch_status(token,workspace,batch['batch_id'])
                        if receipt['state']=='indexed':break
                        if receipt['state']=='failed' or time.monotonic()>=deadline:raise TraceTransferPending(result.batch_refs)
                        runtime.stop.wait(.1)
                        if runtime.stop.is_set():raise TraceTransferPending(result.batch_refs)
                transfer.mark_completed(token,workspace,result)
                respond(dict(success=True,fileName=value.get('fileName') if isinstance(value.get('fileName'),str) else None,**result));return
            if path==['observe','traces','export'] and self.command=='GET':
                from .trace_transfer import LegacyTraceTransfer
                if not params.get('executionId'):raise ValueError('executionId required')
                transfer=LegacyTraceTransfer(runtime.control,runtime.queries,runtime.authorized,metadata,runtime.ingest)
                respond(transfer.export(token,workspace,params['executionId']),limit=128*1024*1024);return
            if path==['observe','data']:
                if self.command=='GET':respond(listing.read(token,workspace,params));return
                value=body()
                if value is None:return
                ref=value.get('upload_id') or value.get('task_id')
                kind='execution' if value.get('upload_id') else 'task'
                if not ref:raise ValueError('explicit Trace identity is required')
                if self.command=='DELETE':
                    with runtime.control.read_transaction() as con:
                        alias=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(workspace,kind,ref)).fetchone()
                    deleted=metadata.delete(token,workspace,alias[0] if alias else ref)
                    respond({'success':True,'count':int(deleted)});return
                if self.command=='PATCH':
                    route=metadata.resolve(token,workspace,ref,kind)
                    changes={key:value[key] for key in ('query','label','final_result','user_feedback') if key in value}
                    if 'query' in changes and (not isinstance(changes['query'],str) or not changes['query'].strip()):raise ValueError('query must be nonempty')
                    # Result editing also schedules evaluation in the existing workflow; that handoff must precede publishing an edit.
                    if 'final_result' in changes:raise Conflict('result editing requires the evaluation handoff to be configured')
                    metadata.patch(token,workspace,route['trace_id'],changes)
                    records=listing.read(token,workspace,{'executionId':route['execution_id']})
                    record=records[0] if records else dict(task_id=route['task_id'],upload_id=route['execution_id'],**changes)
                    respond({'success':True,'record':record,'message':'用户反馈已更新' if 'user_feedback' in changes else 'Label 已更新' if 'label' in changes else 'Query 已更新'});return
            if path==['observe','session'] and self.command=='GET':
                ref=params.get('taskId')
                if not ref:raise ValueError('taskId required')
                route=metadata.resolve(token,workspace,ref)
                view=params.get('view','full');index=params.get('index')
                if index is not None:
                    if not re.fullmatch(r'[0-9]{1,8}',index):raise ValueError('invalid interaction index')
                    index=int(index)
                result=reads.session(token,workspace,route['trace_id'],view=view,index=index)
                annotations=metadata.properties(token,workspace,route['trace_id'])
                for key in ('label','query'):
                    if key in annotations.get('override_fields',[]):result[key]=annotations.get(key)
                result['taskId']=route['task_id']
                if isinstance(result.get('execution'),dict):result['execution'].update(id=route['execution_id'],taskId=route['task_id'])
                respond(result,limit=128*1024*1024);return
            if path==['tags']:
                if self.command=='GET':respond(metadata.list_tags(token,workspace,params.get('kind')));return
                if self.command=='POST':
                    value=body()
                    if value is not None:respond(metadata.create_tag(token,workspace,value),201)
                    return
            if len(path)==2 and path[0]=='tags':
                if self.command=='DELETE':metadata.delete_tag(token,workspace,path[1]);respond({'success':True});return
                if self.command in ('PUT','PATCH'):
                    value=body()
                    if value is not None:respond(metadata.update_tag(token,workspace,path[1],value))
                    return
            if len(path)==3 and path[0]=='executions' and path[2]=='tags':
                route=metadata.resolve(token,workspace,path[1],'execution');trace=route['trace_id']
                if self.command=='GET':respond({'tags':metadata.get_trace_tags(token,workspace,trace)});return
                if self.command=='DELETE':
                    if not params.get('tagId'):raise ValueError('tagId required')
                    respond({'tags':metadata.remove_trace_tag(token,workspace,trace,params['tagId'])});return
                if self.command in ('PUT','POST'):
                    value=body()
                    if value is not None:
                        method=metadata.replace_trace_tags if self.command=='PUT' else metadata.add_trace_tags
                        respond({'tags':method(token,workspace,trace,value.get('tagIds',[]))})
                    return
            self.reply(404,{'error':'Unknown compatibility route'})

        def dispatch(self):
            parsed=urllib.parse.urlsplit(self.path)
            if len(self.path)>16384 or parsed.scheme or parsed.netloc:raise ValueError('invalid path')
            query=urllib.parse.parse_qs(parsed.query,keep_blank_values=True,max_num_fields=32)
            if any(len(values)!=1 for values in query.values()):raise ValueError('duplicate query field')
            params={key:values[0] for key,values in query.items()}
            pieces=[urllib.parse.unquote(p,errors='strict') for p in parsed.path.split('/') if p]
            def number(name,default):
                value=params.get(name)
                if value is None:return default
                if not re.fullmatch(r'-?[0-9]{1,20}',value):raise ValueError('invalid number')
                return int(value)
            if self.command=='GET' and pieces==['v1','health']:
                plan=runtime.control.migration_plan()
                self.reply(200,{'status':'ready','schema_version':plan['current_version'],'worker_enabled':runtime.worker is not None,'worker_error':runtime.last_worker_error});return
            if self.command=='POST' and pieces==['v1','auth','login']:
                body,error=self.body()
                if error:self.reply(error,{'error':'JSON body required or body too large'});return
                self.reply(200,runtime.login(body.get('username'),body.get('password')));return
            token=self.token()
            if pieces[:2]==['v1','compat']:
                self.dispatch_compat(token,pieces,params);return
            if self.command=='GET' and pieces==['v1','auth','me']:
                self.reply(200,runtime.profile(token));return
            if self.command=='POST' and pieces==['v1','auth','logout']:
                runtime.iam.revoke_credential(token);self.reply(200,{'ok':True});return
            if self.command=='POST' and pieces==['v1','ingest','otlp']:
                if not token.startswith('api_'):raise Forbidden('API credential required')
                workspace=runtime.workspace(token,self.headers.get('X-Workspace-Id'),'write')
                body,error=self.body()
                if error:self.reply(error,{'error':'JSON body required or body too large'});return
                receipt=runtime.ingest.accept(token,workspace,body,receipt_key=self.headers.get('Idempotency-Key'))
                self.reply(409 if receipt['state']=='failed' else 200,receipt);return
            if self.command!='GET':self.reply(404,{'error':'Unknown route'});return
            if len(pieces)==3 and pieces[:2]==['v1','batches']:
                # The batch API permits write-only collectors to inspect their own durable receipts.
                scope=runtime.iam.scope(token)
                explicit=params.get('workspace_id')
                workspace=explicit or (runtime.default_workspace if runtime.default_workspace in scope.allowed_workspace_ids else None)
                if not workspace and len(scope.allowed_workspace_ids)==1:workspace=scope.allowed_workspace_ids[0]
                if not workspace:raise ValueError('workspace selection required')
                self.reply(200,runtime.ingest.batch_status(token,workspace,pieces[2]));return
            if pieces[:2]!=['v1','traces']:self.reply(404,{'error':'Unknown route'});return
            workspace=runtime.workspace(token,params.get('workspace_id'),'read')
            if len(pieces)==2:
                self.reply(200,runtime.queries.list_traces(token,workspace,limit=number('limit',50),cursor=params.get('cursor') or None,status=params.get('status') or None,agent=params.get('agent') or None,search=params.get('search') or None));return
            trace=identifier(pieces[2]);route=runtime.queries.route(token,workspace,trace);bucket=route['trace_bucket']
            if len(pieces)==3:self.reply(200,runtime.queries.summary(token,workspace,trace));return
            if pieces[3]!='spans':self.reply(404,{'error':'Unknown route'});return
            if len(pieces)==4:
                limit=number('limit',200)
                if not 1<=limit<=200:raise ValueError('Span page size must be1..200')
                after=params.get('after_span_id','');status=params.get('status') or None
                if status not in (None,'done','failed','running','unknown'):raise ValueError('invalid Span status')
                search=params.get('search') or None
                if search and len(search)>256:raise ValueError('search too long')
                rows=runtime.authorized.read_spans(token,workspace,bucket,trace,limit=limit,after_span_id=after,status=status,parent_span_id=params.get('parent_span_id'),search=search)
                self.reply(200,{'items':rows,'next_span_id':rows[-1]['span_id'] if len(rows)==limit else None});return
            span=identifier(pieces[4])
            if len(pieces)==5:
                self.reply(200,{'span':runtime.authorized.read_span(token,workspace,bucket,trace,span)});return
            if len(pieces)==6 and pieces[5]=='payload':
                rev=params.get('revision');section=params.get('section')
                if not rev or not section:raise ValueError('exact payload revision and section required')
                limit=number('limit',4)
                if not 1<=limit<=4:raise ValueError('payload page size must be1..4')
                self.reply(200,runtime.authorized.read_payload(token,workspace,bucket,trace,span,rev,section,after_chunk=number('after_chunk',-1),limit=limit));return
            self.reply(404,{'error':'Unknown route'})
    return Server((host,port),Handler)


def runtime_from_config(path):
    from .control import SQLiteControlStore
    from .clickhouse import ClickHouseStore
    from .migrations import load_migrations
    target=Path(path)
    if target.is_symlink() or not target.is_file() or target.stat().st_mode & 0o077:raise ValueError('config must be a private regular file')
    config=json.loads(target.read_text())
    backend=config['control']['backend']
    if backend=='sqlite':
        database=Path(config['control']['database'])
        if not database.is_absolute() or not database.is_file():raise ValueError('existing explicit absolute database required')
        control=SQLiteControlStore(database)
    elif backend in ('postgresql','opengauss'):
        from .relational import PostgreSQLControlStore,OpenGaussControlStore
        cls=PostgreSQLControlStore if backend=='postgresql' else OpenGaussControlStore
        control=cls.from_dsn(config['control']['dsn'],schema=config['control']['schema'],artifact_directory=config['control']['artifacts'])
    else:raise ValueError('unknown transactional backend')
    plan=control.migration_plan()
    if plan['current_version']!=len(load_migrations(backend)) or plan['pending']:raise ValueError('explicit schema upgrade is required before service startup')
    facts=ClickHouseStore(**config['clickhouse'])
    runtime=TraceRuntime(control,facts,cursor_secret=bytes.fromhex(config['cursor_secret_hex']),default_workspace=config.get('default_workspace'))
    return runtime,config


def main(argv=None):
    import argparse,signal,threading
    parser=argparse.ArgumentParser(description='Loopback Trace ingestion and query service; requires an explicitly initialized isolated target')
    parser.add_argument('--config',required=True)
    args=parser.parse_args(argv)
    runtime,config=runtime_from_config(args.config)
    server=create_server(runtime,port=config['port'])
    if config.get('worker_enabled',True):runtime.start_worker()
    def stop(*_):threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:server.serve_forever()
    finally:server.server_close();runtime.close()


if __name__=='__main__':main()
