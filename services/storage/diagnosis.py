"""Transactional Trace diagnosis conversations; model execution and its recorder remain external."""
import datetime
import hashlib
import json
import re
import uuid

from .contracts import MAX_REVISION, identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden

MAX_USER_BYTES = 1024 * 1024
MAX_ASSISTANT_BYTES = 8 * 1024 * 1024
MAX_HISTORY_BYTES = 16 * 1024 * 1024
MAX_HISTORY_MESSAGES = 10000
UNSET = object()


class DiagnosisNotFound(StorageError):
    status=404


class DiagnosisTooLarge(StorageError):
    status=413


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':'))


def _bounded(value,limit):
    if len(_json(value).encode('utf-8'))>limit:
        raise DiagnosisTooLarge('Diagnosis response exceeds byte budget')
    return value


def _text(value,limit,*,empty=False):
    if not isinstance(value,str) or (not empty and not value.strip()) or '\x00' in value:
        raise ValueError('valid diagnosis text required')
    if len(value.encode('utf-8'))>limit:
        raise DiagnosisTooLarge('Diagnosis content exceeds byte budget')
    return value


def _hash(value,*,nullable=False):
    if nullable and value is None:return None
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value):raise ValueError('lowercase SHA256 required')
    return value


def _digest(text):return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _iso(ms):
    return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


class TraceDiagnosis:
    def __init__(self,control):
        self.control=control;self.iam=IAMStore(control)

    def _access(self,con,token,ws,ref,*,write=False,internal=False):
        identifier(ws)
        if not isinstance(ref,str) or not ref or '\x00' in ref:raise ValueError('Trace reference required')
        ref.encode('utf-8')
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
        if internal:trace=ref
        else:
            traces={row[0] for row in con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(ws,ref))}
            if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,ref)).fetchone():traces.add(ref)
            if len(traces)>1:raise Conflict('Trace alias is ambiguous')
            trace=next(iter(traces)) if traces else ref
        self.control.lock_keys(con, ('diagnosis', ws, trace), shared=(('trace', ws, trace),))
        self.iam._authorize(con,token,ws,'read','trace',trace)
        if write:self.iam._authorize(con,token,ws,'write','trace',trace)
        route=con.execute('SELECT state,incarnation FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if route is None:raise DiagnosisNotFound('Trace not found')
        if route['state']!='active':raise Conflict('Trace route is not active')
        if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(ws,trace,route['incarnation'])).fetchone():
            raise Conflict('Trace deletion barrier exists')
        alias=con.execute("SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind='execution' ORDER BY created_at_ms,alias_id LIMIT 1",(ws,trace)).fetchone()
        return scope,trace,alias[0] if alias else trace

    @staticmethod
    def _session(con,ws,*,trace=None,session_id=None):
        field,value=('trace_id',trace) if trace is not None else ('session_id',session_id)
        row=con.execute('SELECT * FROM trace_diagnosis_sessions WHERE workspace_id=? AND '+field+'=?',(ws,value)).fetchone()
        return dict(row) if row else None

    def _create(self,con,ws,trace,actor):
        now=revision(self.control.clock()+1)-1;sid=str(uuid.uuid4())
        con.execute('INSERT INTO trace_diagnosis_sessions(workspace_id,session_id,trace_id,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)',(ws,sid,trace,actor,now,now))
        return self._session(con,ws,session_id=sid)

    @staticmethod
    def _session_dto(session,execution):
        if session is None:return None
        return dict(id=session['session_id'],executionId=execution,opencodeSessionId=session['opencode_session_id'],createdAt=_iso(session['created_at_ms']),updatedAt=_iso(session['updated_at_ms']),revision=session['revision'])

    @staticmethod
    def _message_dto(row):
        return dict(id=row['message_id'],role=row['role'],content=row['content'],createdAt=_iso(row['created_at_ms']),seq=row['seq'],revision=row['revision'],state=row['state'],error_code=row['error_code'],opencodeSessionId=row['opencode_session_id'],request_key=row['request_key'])

    def _history(self,con,session,*,before=None,last=None):
        if session is None:return []
        ws,sid=session['workspace_id'],session['session_id']
        if last is not None:
            rows=con.execute('SELECT * FROM trace_diagnosis_messages WHERE workspace_id=? AND session_id=? AND seq<? ORDER BY seq DESC LIMIT '+str(last),(ws,sid,before)).fetchall()
            return [self._message_dto(row) for row in reversed(rows)]
        messages=[];after=0;size=0
        while True:
            page=con.execute('SELECT * FROM trace_diagnosis_messages WHERE workspace_id=? AND session_id=? AND seq>? ORDER BY seq LIMIT 200',(ws,sid,after)).fetchall()
            if not page:break
            for row in page:
                value=self._message_dto(row);size+=len(_json(value).encode('utf-8'));after=row['seq']
                if len(messages)>=MAX_HISTORY_MESSAGES or size>MAX_HISTORY_BYTES:raise DiagnosisTooLarge('Diagnosis history exceeds budget')
                messages.append(value)
        return messages

    def get_session(self,token,ws,trace_ref):
        with self.control.read_transaction() as con:
            scope,trace,execution=self._access(con,token,ws,trace_ref)
            session=self._session(con,ws,trace=trace);version=session['revision'] if session else 0
            result=dict(session=self._session_dto(session,execution),messages=self._history(con,session))
        _bounded(result,MAX_HISTORY_BYTES)
        with self.control.read_transaction() as con:
            current,current_trace,current_execution=self._access(con,token,ws,trace_ref)
            latest=self._session(con,ws,trace=trace)
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Diagnosis permission scope changed')
            if (current_trace,current_execution,latest['revision'] if latest else 0)!=(trace,execution,version):raise Conflict('Diagnosis history changed while reading')
        return result

    @staticmethod
    def _expected(value,actual):
        if value is not None:
            if type(value) is not int or not 0<=value<=MAX_REVISION:raise ValueError('invalid expected revision')
            if value!=actual:raise Conflict('Diagnosis revision changed')

    def _update_session(self,con,session,**changes):
        changes.update(revision=revision(session['revision']+1),updated_at_ms=max(self.control.clock(),session['updated_at_ms']))
        keys=list(changes)
        count=con.execute('UPDATE trace_diagnosis_sessions SET '+','.join(k+'=?' for k in keys)+' WHERE workspace_id=? AND session_id=? AND revision=?',tuple(changes[k] for k in keys)+(session['workspace_id'],session['session_id'],session['revision'])).rowcount
        if count!=1:raise Conflict('Diagnosis session changed')
        session.update(changes)
        return session

    def _messages(self,con,session,key):
        return {row['role']:dict(row) for row in con.execute('SELECT * FROM trace_diagnosis_messages WHERE workspace_id=? AND session_id=? AND request_key=?',(session['workspace_id'],session['session_id'],key))}

    def _expire(self,con,session):
        if session['active_request_key'] is None or self.control.clock()<session['lease_expires_at_ms']:return
        old=self._messages(con,session,session['active_request_key']).get('assistant')
        if old and old['state']=='streaming':
            con.execute("UPDATE trace_diagnosis_messages SET state='interrupted',error_code='lease_expired',revision=?,updated_at_ms=? WHERE workspace_id=? AND message_id=? AND revision=?",(revision(old['revision']+1),max(self.control.clock(),old['updated_at_ms']),session['workspace_id'],old['message_id'],old['revision']))
        self._update_session(con,session,active_request_key=None,lease_owner=None,lease_expires_at_ms=None,turn_fence=revision(session['turn_fence']+1))

    @staticmethod
    def _known_upstream(con,session,value,actor=None):
        if value is None:return None
        identifier(value)
        actors={row[0] for row in con.execute('SELECT DISTINCT created_by FROM trace_diagnosis_messages WHERE workspace_id=? AND session_id=? AND opencode_session_id=?',(session['workspace_id'],session['session_id'],value))}
        if not actors and value==session['opencode_session_id']:actors.add(session['created_by'])
        if len(actors)!=1:raise Conflict('Upstream diagnosis session is not registered to one actor of this Trace')
        owner=next(iter(actors))
        if actor is not None and owner!=actor:raise Conflict('Upstream diagnosis session belongs to another actor')
        return owner

    def ensure_session(self,token,ws,trace_ref,*,opencode_session_id=UNSET,expected_revision=None):
        if opencode_session_id is not UNSET and opencode_session_id is not None:identifier(opencode_session_id)
        with self.control.transaction(shared=(('diagnosis', ws), ('trace', ws),)) as con:
            scope,trace,execution=self._access(con,token,ws,trace_ref,write=True)
            session=self._session(con,ws,trace=trace)
            self._expected(expected_revision,session['revision'] if session else 0)
            if session is None:session=self._create(con,ws,trace,scope.principal_id)
            self._expire(con,session)
            if opencode_session_id is not UNSET and opencode_session_id!=session['opencode_session_id']:
                if session['active_request_key'] is not None:raise Conflict('Diagnosis turn is active')
                self._known_upstream(con,session,opencode_session_id,scope.principal_id)
                self._update_session(con,session,opencode_session_id=opencode_session_id)
            return dict(session=self._session_dto(session,execution))

    @staticmethod
    def _lease(lease_ms):
        if type(lease_ms) is not int or not 1000<=lease_ms<=300000:raise ValueError('lease must be 1000..300000 milliseconds')
        return lease_ms

    def _result(self,con,session,execution,key,scope,*,duplicate=False,history=False):
        messages=self._messages(con,session,key);user=messages['user'];assistant=messages['assistant']
        active=session['active_request_key']==key
        result=dict(session=self._session_dto(session,execution),user_message=self._message_dto(user),assistant_message=self._message_dto(assistant),
            duplicate=duplicate,is_first_user_message=user['seq']==1,opencode_session_id=user['opencode_session_id'],upstream_principal_id=self._known_upstream(con,session,user['opencode_session_id']),principal_id=scope.principal_id,workspace_id=session['workspace_id'],trace_id=session['trace_id'],
            workspace_key='diagnosis-'+_digest(_json([session['workspace_id'],session['session_id']])),
            turn=dict(request_key=key,fence=assistant['turn_fence'],lease_owner=session['lease_owner'] if active else None,user_message_id=user['message_id'],assistant_message_id=assistant['message_id'],revision=assistant['revision'],state=assistant['state'],lease_expires_at_ms=session['lease_expires_at_ms'] if active else None))
        if history:result['messages']=self._history(con,session,before=user['seq'],last=24)
        return _bounded(result,MAX_HISTORY_BYTES)

    def begin_turn(self,token,ws,trace_ref,*,request_key,message,evidence_hash,lease_owner,opencode_session_id=UNSET,model_key=None,context_hash=None,expected_revision=None,lease_ms=90000):
        identifier(request_key);identifier(lease_owner);_text(message,MAX_USER_BYTES);_hash(evidence_hash);_hash(context_hash,nullable=True);self._lease(lease_ms)
        if model_key is not None:identifier(model_key)
        if opencode_session_id is not UNSET and opencode_session_id is not None:identifier(opencode_session_id)
        intent={'mode':'default'} if opencode_session_id is UNSET else {'mode':'new' if opencode_session_id is None else 'known','id':opencode_session_id}
        digest=_digest(_json(dict(message=message,evidence_hash=evidence_hash,model_key=model_key,context_hash=context_hash,continuation=intent)))
        with self.control.transaction(shared=(('diagnosis', ws), ('trace', ws),)) as con:
            scope,trace,execution=self._access(con,token,ws,trace_ref,write=True)
            session=self._session(con,ws,trace=trace)
            if session is None:
                self._expected(expected_revision,0);session=self._create(con,ws,trace,scope.principal_id)
            self._expire(con,session)
            previous=self._messages(con,session,request_key)
            if previous:
                if previous['user']['created_by']!=scope.principal_id:raise Forbidden('Diagnosis turn belongs to another actor')
                if previous['user']['request_hash']!=digest:raise Conflict('Diagnosis request key used for another input')
                return self._result(con,session,execution,request_key,scope,duplicate=True,history=True)
            self._expected(expected_revision,session['revision'] if session['next_sequence']!=1 or expected_revision!=0 else 0)
            if session['active_request_key'] is not None:raise Conflict('Diagnosis turn is active')
            upstream=session['opencode_session_id'] if opencode_session_id is UNSET else opencode_session_id
            self._known_upstream(con,session,upstream,scope.principal_id)
            seq=session['next_sequence'];revision(seq+2);fence=revision(session['turn_fence']+1);now=max(self.control.clock(),session['updated_at_ms']);expires=revision(now+lease_ms)
            for role,content,state,position in [('user',message,'accepted',seq),('assistant','','streaming',seq+1)]:
                con.execute('INSERT INTO trace_diagnosis_messages(workspace_id,session_id,message_id,seq,request_key,request_hash,role,state,content,content_hash,evidence_hash,opencode_session_id,created_by,turn_fence,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (ws,session['session_id'],str(uuid.uuid4()),position,request_key,digest,role,state,content,_digest(content),evidence_hash,upstream,scope.principal_id,fence,now,now))
            self._update_session(con,session,next_sequence=seq+2,turn_fence=fence,active_request_key=request_key,lease_owner=lease_owner,lease_expires_at_ms=expires)
            return self._result(con,session,execution,request_key,scope,history=True)

    def _turn(self,con,token,ws,sid,key,owner,fence,*,terminal=False):
        identifier(sid);identifier(key);identifier(owner);revision(fence)
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read');self.iam._workspace(scope,ws,'write')
        session=self._session(con,ws,session_id=sid)
        if session is None:raise DiagnosisNotFound('Diagnosis session not found')
        scope,_,execution=self._access(con,token,ws,session['trace_id'],write=True,internal=True)
        session=self._session(con,ws,session_id=sid)
        pair=self._messages(con,session,key)
        if len(pair)!=2:raise Conflict('Diagnosis turn not found')
        if pair['assistant']['created_by']!=scope.principal_id:raise Forbidden('Diagnosis turn belongs to another actor')
        if pair['assistant']['turn_fence']!=fence:raise Conflict('Diagnosis turn fence changed')
        if terminal and pair['assistant']['state']!='streaming':return session,pair,scope,execution
        if session['active_request_key']!=key or session['lease_owner']!=owner or session['turn_fence']!=fence or self.control.clock()>=session['lease_expires_at_ms']:
            raise Conflict('Diagnosis turn lease is no longer valid')
        if pair['assistant']['state']!='streaming':raise Conflict('Diagnosis turn is terminal')
        return session,pair,scope,execution

    def renew(self,token,ws,session_id,*,request_key,lease_owner,turn_fence,lease_ms=90000):
        self._lease(lease_ms)
        with self.control.transaction(shared=(('diagnosis', ws), ('trace', ws),)) as con:
            session,pair,scope,execution=self._turn(con,token,ws,session_id,request_key,lease_owner,turn_fence)
            expiry=revision(max(session['lease_expires_at_ms'],self.control.clock()+lease_ms))
            self._update_session(con,session,lease_expires_at_ms=expiry)
            return self._result(con,session,execution,request_key,scope)

    def checkpoint(self,token,ws,session_id,*,request_key,lease_owner,turn_fence,expected_revision,content):
        revision(expected_revision);_text(content,MAX_ASSISTANT_BYTES,empty=True)
        with self.control.transaction(shared=(('diagnosis', ws), ('trace', ws),)) as con:
            session,pair,scope,execution=self._turn(con,token,ws,session_id,request_key,lease_owner,turn_fence)
            old=pair['assistant']
            if old['content']==content and expected_revision in (old['revision'],old['revision']-1):return self._result(con,session,execution,request_key,scope)
            self._expected(expected_revision,old['revision'])
            con.execute('UPDATE trace_diagnosis_messages SET content=?,content_hash=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND message_id=? AND revision=?',(content,_digest(content),revision(old['revision']+1),max(self.control.clock(),old['updated_at_ms']),ws,old['message_id'],old['revision']))
            self._update_session(con,session)
            return self._result(con,session,execution,request_key,scope)

    def finish_turn(self,token,ws,session_id,*,request_key,lease_owner,turn_fence,expected_revision,content,opencode_session_id=None,state='done',error_code=None):
        revision(expected_revision);_text(content,MAX_ASSISTANT_BYTES,empty=True)
        if state not in ('done','failed','interrupted'):raise ValueError('terminal diagnosis state required')
        if opencode_session_id is not None:identifier(opencode_session_id)
        if state=='done' and error_code is not None:raise ValueError('successful diagnosis cannot have error code')
        if state!='done':
            identifier(error_code)
            if len(error_code)>128:raise ValueError('diagnosis error code too long')
        with self.control.transaction(shared=(('diagnosis', ws), ('trace', ws),)) as con:
            session,pair,scope,execution=self._turn(con,token,ws,session_id,request_key,lease_owner,turn_fence,terminal=True)
            old=pair['assistant']
            same=(old['content'],old['state'],old['opencode_session_id'],old['error_code'])==(content,state,opencode_session_id,error_code)
            if old['state']!='streaming':
                if same and expected_revision in (old['revision'],old['revision']-1):return self._result(con,session,execution,request_key,scope,duplicate=True)
                raise Conflict('Diagnosis turn is already terminal')
            self._expected(expected_revision,old['revision'])
            if old['opencode_session_id'] is not None and opencode_session_id!=old['opencode_session_id']:
                raise Conflict('Diagnosis upstream continuation changed')
            if opencode_session_id is not None:
                if con.execute('SELECT 1 FROM trace_diagnosis_messages WHERE workspace_id=? AND opencode_session_id=? AND session_id<>?',(ws,opencode_session_id,session_id)).fetchone():raise Conflict('Diagnosis upstream belongs to another Trace')
                if con.execute('SELECT 1 FROM trace_diagnosis_sessions WHERE workspace_id=? AND opencode_session_id=? AND session_id<>?',(ws,opencode_session_id,session_id)).fetchone():raise Conflict('Diagnosis upstream belongs to another Trace')
            now=max(self.control.clock(),old['updated_at_ms'])
            con.execute('UPDATE trace_diagnosis_messages SET content=?,content_hash=?,state=?,opencode_session_id=?,error_code=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND message_id=? AND revision=?',(content,_digest(content),state,opencode_session_id,error_code,revision(old['revision']+1),now,ws,old['message_id'],old['revision']))
            user=pair['user']
            if user['opencode_session_id']!=opencode_session_id:
                con.execute('UPDATE trace_diagnosis_messages SET opencode_session_id=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND message_id=? AND revision=?',(opencode_session_id,revision(user['revision']+1),max(now,user['updated_at_ms']),ws,user['message_id'],user['revision']))
            self._update_session(con,session,opencode_session_id=opencode_session_id,active_request_key=None,lease_owner=None,lease_expires_at_ms=None)
            return self._result(con,session,execution,request_key,scope)
