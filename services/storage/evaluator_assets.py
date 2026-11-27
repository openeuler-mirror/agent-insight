"""Actor-bound evaluator authoring lists and immutable, secret-free runtime definitions."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .contracts import identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden

MAX_LIST_BYTES=8*1024*1024
MAX_CARD_BYTES=1024*1024
MAX_CARDS=1000
def _secret(key):
    value=re.sub('[^a-z0-9]','',key.lower())
    return value in {'authorization','proxyauthorization','cookie','setcookie','token'} or value.endswith(('apikey','accesstoken','refreshtoken','secret','password','credential','privatekey'))



def _json(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def _hash(value):return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()
def _id(*parts):return str(uuid.uuid5(uuid.NAMESPACE_URL,_json(parts)))


def _bounded(value,limit):
    total=0
    for part in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).iterencode(value):
        total+=len(part.encode('utf-8'))
        if total>limit:raise ValueError('Evaluator exceeds byte budget')


def _runtime(value):
    if isinstance(value,dict):return {key:_runtime(item) for key,item in value.items() if not _secret(key)}
    if isinstance(value,list):return [_runtime(item) for item in value]
    if isinstance(value,str) and value.lower().startswith(('http://','https://')):
        try:parts=urlsplit(value)
        except ValueError:return value
        query=parse_qsl(parts.query,keep_blank_values=True)
        if parts.username is None and parts.password is None and not any(_secret(key) for key,_ in query):return value
        if parts.username is not None or parts.password is not None:
            host=parts.hostname or '';host='['+host+']' if ':' in host else host
            parts=parts._replace(netloc=host+(':'+str(parts.port) if parts.port else ''))
        return urlunsplit(parts._replace(query=urlencode([(k,v) for k,v in query if not _secret(k)])))
    return value


class EvaluatorAssets:
    def __init__(self,control):self.control=control;self.iam=IAMStore(control)

    def _persist(self,value):
        _bounded(value,MAX_LIST_BYTES)
        return self.control.persist_artifact({'encoding':'evaluator-json/v1','json':_json(value)})

    def _load(self,digest,ref):
        path=Path(ref);directory=self.control.artifact_directory
        if path.parent!=directory or directory.is_symlink() or path.name!=digest or not re.fullmatch('[0-9a-f]{64}',digest):raise StorageError('Invalid evaluator artifact')
        try:
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as stream:
                info=os.fstat(stream.fileno());limit=MAX_LIST_BYTES*6+4096
                if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise StorageError('Evaluator artifact exceeds budget')
                raw=stream.read(limit+1)
            if len(raw)>limit or hashlib.sha256(raw).hexdigest()!=digest:raise StorageError('Evaluator artifact checksum differs')
            wrapper=json.loads(raw.decode('utf-8'))
            if wrapper['encoding']!='evaluator-json/v1' or not isinstance(wrapper['json'],str):raise ValueError()
            if len(wrapper['json'].encode('utf-8'))>MAX_LIST_BYTES:raise ValueError()
            value=json.loads(wrapper['json'],parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            _bounded(value,MAX_LIST_BYTES);return value
        except (OSError,KeyError,ValueError,TypeError,UnicodeError,RecursionError):raise StorageError('Evaluator artifact unavailable') from None

    def _actor(self,con,token,ws,write=False):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
        if write:self.iam._workspace(scope,ws,'write')
        return scope

    def _family(self,ws,principal,identity):return _id('evaluator',ws,principal,identity)

    def _head(self,con,token,ws,write=False):
        scope=self._actor(con,token,ws,write);asset=_id('evaluator-list',ws,scope.principal_id)
        row=self._alias(con,ws,asset)
        if row:self.iam._authorize(con,token,ws,'write' if write else 'read','asset',asset)
        return scope,asset,row

    @staticmethod
    def _alias(con,ws,asset):
        row=con.execute("SELECT a.etag,a.release_id,a.updated_at_ms,r.content_hash,r.manifest_ref FROM asset_aliases a JOIN asset_releases r ON r.workspace_id=a.workspace_id AND r.asset_id=a.asset_id AND r.release_id=a.release_id JOIN asset_release_seals s ON s.workspace_id=r.workspace_id AND s.release_id=r.release_id WHERE a.workspace_id=? AND a.asset_id=? AND a.alias='latest'",(ws,asset)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _etag(asset,head):return '"evaluators:'+asset+':'+str(head['etag'] if head else 0)+'"'

    def _postflight(self,token,ws,head,fingerprint,write=False):
        with self.control.read_transaction() as con:
            scope,_,current=self._head(con,token,ws,write)
            if scope.fingerprint!=fingerprint:raise Forbidden('Evaluator authorization changed')
            if current!=head:raise Conflict('Evaluator list changed while reading')

    def _snapshot(self,asset,head,value=None):
        if head is None:return {'evaluators':[],'releases':[],'etag':self._etag(asset,None),'list_release_id':None}
        value=value or self._load(head['content_hash'],head['manifest_ref'])
        if value.get('format')!='agent-insight.evaluator-list' or value.get('version')!=1:raise StorageError('Invalid evaluator list')
        return {'evaluators':copy.deepcopy(value['evaluators']),'releases':copy.deepcopy(value['releases']),'etag':self._etag(asset,head),'list_release_id':head['release_id']}

    def read(self,token,ws):
        with self.control.read_transaction() as con:scope,asset,head=self._head(con,token,ws)
        try:return self._snapshot(asset,head)
        finally:self._postflight(token,ws,head,scope.fingerprint)

    def _receipt(self,con,ws,asset,key):
        row=con.execute("SELECT r.content_hash,r.manifest_ref FROM asset_releases r JOIN asset_release_seals s ON s.workspace_id=r.workspace_id AND s.release_id=r.release_id WHERE r.workspace_id=? AND r.asset_id=? AND r.version_label=?",(ws,asset,'operation:'+hashlib.sha256(key.encode('utf-8')).hexdigest())).fetchone()
        return dict(row) if row else None

    def _replay(self,token,ws,key,digest,expected_etag=None):
        with self.control.read_transaction() as con:
            scope,asset,head=self._head(con,token,ws,True);receipt=self._receipt(con,ws,asset,key)
            if receipt is None and expected_etag is not None and expected_etag!=self._etag(asset,head):raise Conflict('Evaluator list changed before normalization')
        if receipt is None:return None
        try:
            value=self._load(receipt['content_hash'],receipt['manifest_ref'])
            if value.get('format')!='agent-insight.evaluator-operation' or value.get('request_hash')!=digest:raise Conflict('Evaluator operation has different input')
            return value['response']
        finally:self._postflight(token,ws,head,scope.fingerprint,True)

    def lookup(self,token,ws,*,operation_key,expected_etag,operation_request):
        identifier(operation_key)
        if not isinstance(expected_etag,str) or not expected_etag:raise ValueError('Evaluator version required')
        _bounded(operation_request,MAX_LIST_BYTES)
        return self._replay(token,ws,operation_key,_hash({'request':operation_request,'expected_etag':expected_etag}),expected_etag)

    def _insert_release(self,con,scope,ws,asset,release,label,artifact,now):
        con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',(ws,release,asset,label,artifact[0],artifact[1],scope.principal_id,now))
        con.execute('INSERT INTO asset_release_seals(workspace_id,release_id,asset_id,dependency_count,created_at_ms) VALUES(?,?,?,0,?)',(ws,release,asset,now))

    def _publish(self,con,scope,token,ws,asset,previous,artifact,now):
        current=self._alias(con,ws,asset)
        if current!=previous:raise Conflict('Evaluator asset changed concurrently')
        if current:
            self.iam._authorize(con,token,ws,'write','asset',asset)
            if current['content_hash']==artifact[0]:return current['release_id'],False
        else:
            con.execute("INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES(?,?,'evaluator',?,?,?)",(ws,asset,'evaluator:'+asset,now,now))
            self.iam._record_resource(con,ws,'asset',asset,scope.principal_id,'private',invalidate_policy=False)
        number=revision(previous['etag']+1) if previous else 1;release=_id(asset,number,artifact[0])
        self._insert_release(con,scope,ws,asset,release,str(number),artifact,now)
        if previous:con.execute("UPDATE asset_aliases SET release_id=?,etag=?,updated_at_ms=? WHERE workspace_id=? AND asset_id=? AND alias='latest'",(release,number,now,ws,asset))
        else:con.execute("INSERT INTO asset_aliases(workspace_id,asset_id,alias,release_id,etag,created_at_ms,updated_at_ms) VALUES(?,?,'latest',?,1,?,?)",(ws,asset,release,now,now))
        return release,True

    def save(self,token,ws,evaluators,*,expected_etag,operation_key,operation_request=None):
        identifier(operation_key)
        if not isinstance(expected_etag,str) or not expected_etag:raise ValueError('Evaluator version required')
        if not isinstance(evaluators,list) or len(evaluators)>MAX_CARDS:raise ValueError('Bounded evaluator list required')
        _bounded(evaluators,MAX_LIST_BYTES);seen=set()
        for card in evaluators:
            if not isinstance(card,dict):raise ValueError('Evaluator card object required')
            identifier(card.get('id'));_bounded(card,MAX_CARD_BYTES)
            if card['id'] in seen:raise ValueError('Duplicate evaluator identity')
            seen.add(card['id'])
        request=operation_request if operation_request is not None else {'evaluators':evaluators}
        _bounded(request,MAX_LIST_BYTES)
        digest=_hash({'request':request,'expected_etag':expected_etag})
        old=self._replay(token,ws,operation_key,digest)
        if old is not None:return old
        with self.control.read_transaction() as con:
            scope,asset,head=self._head(con,token,ws,True)
            if expected_etag!=self._etag(asset,head):raise Conflict('Evaluator list changed concurrently')
            families=[]
            for card in evaluators:
                family=self._family(ws,scope.principal_id,card['id']);prior=self._alias(con,ws,family)
                if prior:self.iam._authorize(con,token,ws,'write','asset',family)
                families.append((card,family,prior))
        prepared=[]
        for card,family,prior in families:
            artifact=self._persist({'format':'agent-insight.evaluator-definition','version':1,'evaluator_id':card['id'],'card':{**_runtime(card),'source':'custom'}})
            prepared.append((card,family,prior,artifact))
        members=[]
        for card,family,prior,artifact in prepared:
            release=prior['release_id'] if prior and prior['content_hash']==artifact[0] else _id(family,revision(prior['etag']+1) if prior else 1,artifact[0])
            members.append({'evaluator_id':card['id'],'asset_id':family,'release_id':release,'content_hash':artifact[0],'origin':'user'})
        root=self._persist({'format':'agent-insight.evaluator-list','version':1,'evaluators':evaluators,'releases':members})
        unchanged=head is not None and head['content_hash']==root[0]
        number=head['etag'] if unchanged else revision(head['etag']+1) if head else 1
        release=head['release_id'] if unchanged else _id(asset,number,root[0])
        response={'evaluators':copy.deepcopy(evaluators),'releases':members,'etag':self._etag(asset,{'etag':number}),'list_release_id':release}
        receipt_body=self._persist({'format':'agent-insight.evaluator-operation','version':1,'request_hash':digest,'response':response})
        with self.control.transaction(('evaluator', ws, asset), ('asset', ws, asset),
                                      *(('asset', ws, family) for _,family,_,_ in prepared)) as con:
            live,_,current=self._head(con,token,ws,True)
            if live.fingerprint!=scope.fingerprint:raise Forbidden('Evaluator authorization changed before save')
            receipt=self._receipt(con,ws,asset,operation_key)
            if receipt is None:
                if current!=head:raise Conflict('Evaluator list changed concurrently')
                now=max([self.control.clock(),head['updated_at_ms'] if head else 0]+[prior['updated_at_ms'] for _,_,prior,_ in prepared if prior])
                for (_,family,prior,artifact),member in zip(prepared,members):
                    published,_=self._publish(con,live,token,ws,family,prior,artifact,now)
                    if published!=member['release_id']:raise Conflict('Evaluator prepared release differs')
                published,_=self._publish(con,live,token,ws,asset,head,root,now)
                if published!=release:raise Conflict('Evaluator prepared list differs')
                self._insert_release(con,live,ws,asset,_id(asset,'operation',operation_key),'operation:'+hashlib.sha256(operation_key.encode('utf-8')).hexdigest(),receipt_body,now)
        result=self._replay(token,ws,operation_key,digest)
        if result is None:raise Conflict('Evaluator receipt unavailable')
        return result

    def freeze(self,token,ws,evaluator_ids,*,expected_etag=None):
        if not isinstance(evaluator_ids,list) or len(evaluator_ids)>MAX_CARDS or len(set(evaluator_ids))!=len(evaluator_ids):raise ValueError('Unique evaluator identities required')
        for value in evaluator_ids:identifier(value)
        with self.control.read_transaction() as con:scope,asset,head=self._head(con,token,ws)
        try:
            snapshot=self._snapshot(asset,head)
            if expected_etag is not None and expected_etag!=snapshot['etag']:raise Conflict('Evaluator list changed before freeze')
            by_id={row['evaluator_id']:row for row in snapshot['releases']};cards={};members=[]
            for identity in evaluator_ids:
                member=by_id.get(identity)
                if member is None:raise LookupError('Evaluator not found')
                with self.control.read_transaction() as con:
                    self.iam._authorize(con,token,ws,'read','asset',member['asset_id'])
                    release=con.execute('SELECT r.* FROM asset_releases r JOIN asset_release_seals s ON s.workspace_id=r.workspace_id AND s.release_id=r.release_id JOIN asset_identities a ON a.workspace_id=r.workspace_id AND a.asset_id=r.asset_id WHERE r.workspace_id=? AND r.asset_id=? AND r.release_id=? AND a.kind=\'evaluator\'',(ws,member['asset_id'],member['release_id'])).fetchone()
                if release is None or release['content_hash']!=member['content_hash']:raise StorageError('Evaluator release binding differs')
                value=self._load(release['content_hash'],release['manifest_ref'])
                if value.get('format')!='agent-insight.evaluator-definition' or value.get('version')!=1 or value.get('evaluator_id')!=identity:raise StorageError('Invalid runtime evaluator definition')
                cards[identity]=value['card'];members.append(member)
            return {'schemaVersion':1,'cards':cards,'releases':members,'list_etag':snapshot['etag']}
        finally:
            self._postflight(token,ws,head,scope.fingerprint)
            with self.control.read_transaction() as con:
                for member in locals().get('members',[]):self.iam._authorize(con,token,ws,'read','asset',member['asset_id'])

    def dispatch(self,token,ws,action,payload):
        if action=='read':return self.read(token,ws)
        if action=='save':return self.save(token,ws,payload.get('evaluators'),expected_etag=payload.get('expected_etag'),operation_key=payload.get('operation_key'),operation_request=payload.get('operation_request'))
        if action=='lookup':return self.lookup(token,ws,operation_key=payload.get('operation_key'),expected_etag=payload.get('expected_etag'),operation_request=payload.get('operation_request'))
        if action=='freeze':return self.freeze(token,ws,payload.get('evaluator_ids'),expected_etag=payload.get('expected_etag'))
        raise ValueError('Unsupported evaluator action')
