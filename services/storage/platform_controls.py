"""Fixed platform control records, preserving original domain DTOs and transactions."""
import copy
import base64
import binascii
import datetime
import hashlib
import json
import math
import secrets
from pathlib import Path
import uuid
from dataclasses import replace

from .control import Conflict, StorageError
from .contracts import identifier
from .iam import IAMStore, Forbidden
from .legacy_history import assert_control_live, is_historical_control

MODELS=json.loads((Path(__file__).parent/'schema/platform-control-models.json').read_text())['models']
MAX_RECORDS=20000
MAX_BYTES=128*1024*1024
SECRET_KINDS=frozenset({'user','userSettings','reliabilityInstallToken','reliabilityClientCredential','reliabilityClientConfig','reliabilityConfigSnapshot','reliabilityCommand','skillDeployment','faultInjectionTask','faultInjectionRun','faultInjectionWorker','grayscaleTask'})
PREPARATION_KINDS=frozenset({'skill','skillVersion','config','parsedFlow','registeredAgent','userSettings'})
BODY_FIELDS=frozenset({'output','content','files','filesJson','settingsJson','blocks','blocksJson','payloadJson','resultJson','overrideJson','effectiveJson','snapshotJson','itemsJson','candidateFilesJson','sourceRefsJson','rawOutput','flowJson','mermaidCode','apiKey','tokenHash','credentialHash'})
TERMINAL=frozenset({'SUCCEEDED','FAILED','EXPIRED','DELIVERY_FAILED'})
PARENT_PRIORITY={'skillVersion':'skill','evaluation':'skill','skillIssue':'skill','skillGeneratorMessage':'skillGeneratorSession','skillOptPlan':'skillOptSession','skillOptMessage':'skillOptSession','skillOptIteration':'skillOptSession','skillOptPlanItem':'skillOptPlan','skillWorkbenchMessage':'skillWorkbenchSession','skillWorkbenchTask':'skillWorkbenchSession','skillOptimizationRecord':'skillWorkbenchSession','skillSnapshotEvaluation':'skillWorkbenchSession','reliabilityClientCredential':'reliabilityClient','reliabilityCommand':'reliabilityClient','reliabilityClientConfig':'reliabilityClient','reliabilityConfigDelivery':'reliabilityClient','skillDeployment':'reliabilityClient','skillDeploymentEvent':'skillDeployment'}
LOOKUPS={'user':'apiKey','reliabilityInstallToken':'tokenHash','reliabilityClient':'clientId','reliabilityClientCredential':'credentialHash','reliabilityCommand':'commandId','reliabilityConfigSnapshot':'configRef','reliabilityConfigDelivery':'deliveryId','skillDeployment':'deploymentId'}


def _json(value):return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))
def _hash(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'),sort_keys=True).encode()).hexdigest()
def _iso(value):return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def _ms(value):
    if isinstance(value,str):
        try:return int(datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)
        except ValueError:raise ValueError('Invalid control timestamp') from None
    if type(value) is int:return value
    raise ValueError('Invalid control timestamp')
def _id():return 'ctl_'+uuid.uuid4().hex
def _revision(value):
    if type(value) is int and value>=0:return value
    if isinstance(value,str) and value.isdigit():return int(value)
    raise ValueError('Control revision required')
def _body_field(field):return field in BODY_FIELDS or field.endswith('Json')


class PlatformControls:
    def __init__(self,control):self.control=control;self.iam=IAMStore(control);self.capability=None

    def _persist(self,value):
        text=_json(value)
        if len(text.encode())>MAX_BYTES:raise ValueError('Control record exceeds byte budget')
        digest,ref=self.control.persist_artifact({'text':text})
        return hashlib.sha256(text.encode()).hexdigest(),ref

    def _load(self,ref,digest=None):
        from .observations import ObservationIngest
        value=ObservationIngest(self.control,None)._load(ref)
        if not isinstance(value,dict) or set(value)!={'text'} or not isinstance(value['text'],str):raise StorageError('Invalid control artifact')
        if digest and hashlib.sha256(value['text'].encode()).hexdigest()!=digest:raise StorageError('Control artifact differs')
        return json.loads(value['text'])

    def _scope(self,con,token,workspace,capability):
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=19').fetchone():raise StorageError('Explicit019 control migration required')
        scope=self._capability_scope(con)[0] if self.capability else self.iam._scope(con,token);grant=self.iam._workspace(scope,workspace,capability)
        return scope,grant

    def _scope_revision(self,con,workspace,owner,kind=None):
        owner=owner if kind is None else _hash([owner,kind])
        row=con.execute("SELECT revision FROM platform_control_records WHERE workspace_id=? AND kind='_scope' AND record_id=?",(workspace,owner)).fetchone()
        return int(row[0]) if row else 0

    def _bump_scope(self,con,workspace,owner,username,kind=None):
        identity=owner if kind is None else _hash([owner,kind])
        current=self._scope_revision(con,workspace,owner,kind);now=self.control.clock()
        if current:
            con.execute("UPDATE platform_control_records SET revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND kind='_scope' AND record_id=?",(now,workspace,identity))
        else:
            digest,ref=self._persist({})
            con.execute('INSERT INTO platform_control_records(workspace_id,kind,record_id,owner_principal_id,legacy_username,sort_ms,metadata_json,payload_hash,payload_ref,state,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(workspace,'_scope',identity,owner,username,now,'{}',digest,ref,'active',1,now,now))
        return current+1

    def _row(self,con,workspace,kind,identity,include_deleted=False):
        row=con.execute('SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND record_id=?'+('' if include_deleted else " AND state='active'"),(workspace,kind,identity)).fetchone()
        return dict(row) if row else None

    def _data(self,row):
        value=self._load(row['payload_ref'],row['payload_hash'])
        return value['data'] if isinstance(value,dict) and value.get('format')=='platform-skill-files/v1' else value

    def _file_bundle(self,row):
        value=self._load(row['payload_ref'],row['payload_hash'])
        return value.get('files',[]) if isinstance(value,dict) and value.get('format')=='platform-skill-files/v1' else []

    def _validate_files(self,files):
        if not isinstance(files,list) or len(files)>10000:raise ValueError('Bounded Skill file bundle required')
        seen=set();size=0
        for item in files:
            if not isinstance(item,dict) or set(item)!={'path','content','mode'}:raise ValueError('Fixed Skill file entry required')
            name=item['path']
            if not isinstance(name,str) or len(name)>2048 or name.startswith('/') or '\\' in name or any(part in ('','.','..') for part in name.split('/')) or any(ord(c)<32 for c in name) or name in seen:raise ValueError('Safe unique Skill file path required')
            seen.add(name)
            if type(item['mode']) is not int or not 0<=item['mode']<=511:raise ValueError('Skill file mode required')
            try:raw=base64.b64decode(item['content'],validate=True)
            except (ValueError,binascii.Error,TypeError):raise ValueError('Skill file bytes required') from None
            size+=len(raw)
            if size>MAX_BYTES:raise ValueError('Skill file package exceeds budget')
        return files

    def _model(self,kind):
        if kind not in MODELS:raise ValueError('Unsupported fixed control kind')
        return MODELS[kind]

    def _can_read(self,con,scope,grant,row,private=False,preparation=False):
        if self.capability and self.capability.get('type')=='device' and not self._device_visible(con,row):return False
        if self._peer_record(row):return True
        if row['owner_principal_id']==scope.principal_id:return True
        if private or row['kind'] in SECRET_KINDS:return False
        if row.get('asset_id'):
            if preparation and row['kind'] in {'skill','skillVersion'}:
                shared=con.execute("SELECT visibility FROM iam_resource_access WHERE workspace_id=? AND resource_kind='asset' AND resource_id=?",(row['workspace_id'],row['asset_id'])).fetchone()
                if shared and (shared[0]=='group' or con.execute("SELECT 1 FROM iam_resource_grants WHERE workspace_id=? AND resource_kind='asset' AND resource_id=? AND grantee_principal_id=?",(row['workspace_id'],row['asset_id'],scope.principal_id)).fetchone()):return True
            try:self.iam._authorize_scope(con,scope,row['workspace_id'],'read','asset',row['asset_id']);return True
            except Forbidden:return False
        return grant.role in {'owner','admin','personal'}

    def _normalize(self,kind,data,username,old=None):
        model=self._model(kind)
        if not isinstance(data,dict) or set(data)-set(model['fields']):raise ValueError('Unknown control field')
        result=copy.deepcopy(old or {});now=_iso(self.control.clock())
        for field,spec in model['fields'].items():
            if field in data:result[field]=copy.deepcopy(data[field])
            elif field not in result and spec['updated']:result[field]=now
            elif field not in result:
                default=spec['default']
                if default and 'value' in default:result[field]=copy.deepcopy(default['value'])
                elif default and default.get('factory')=='id':result[field]=_id()
                elif default and default.get('factory')=='now':result[field]=now
                elif spec['nullable']:result[field]=None
                else:raise ValueError('Required control field missing: '+field)
            if spec['updated']:result[field]=now
            value=result[field]
            if value is None:
                if not spec['nullable']:raise ValueError('Nonnullable control field')
                continue
            typ=spec['type']
            if typ=='String' and not isinstance(value,str):raise ValueError('Control text required')
            if typ in {'Int','BigInt'} and (type(value) is not int or not -(2**(31 if typ=='Int' else 63))<=value<2**(31 if typ=='Int' else 63)):raise ValueError('Control integer range differs')
            if typ=='Float' and (type(value) not in (int,float) or not math.isfinite(value)):raise ValueError('Finite control number required')
            if typ=='Boolean' and type(value) is not bool:raise ValueError('Control boolean required')
            if typ=='DateTime':_ms(value)
        if kind=='user' and result['username']!=username:raise Forbidden('Control username differs')
        if 'user' in result and result['user'] not in (None,username):raise Forbidden('Control owner label differs')
        if old:
            for field in ('id','clientId','commandId','deploymentId','configRef','credentialHash','tokenHash'):
                if field in old and result.get(field)!=old[field] and not (kind=='reliabilityInstallToken' and field=='clientId' and old[field] is None):raise Conflict('Control identity cannot change')
        if kind=='evaluation' and result.get('type') not in (None,'static'):raise Forbidden('Dynamic evaluations use the typed result store')
        if kind=='skillIssue' and result.get('source') not in (None,'static','feedback'):raise Forbidden('Dynamic issues use the typed issue store')
        if kind=='reliabilityCommand':
            status=result.get('status')
            if status not in {'CREATED','SENT','RECEIVED','RUNNING',*TERMINAL}:raise ValueError('Invalid command state')
            if old and old['status'] in TERMINAL and any(result.get(field)!=old.get(field) for field in ('status','resultJson','receivedAt','startedAt','completedAt','errorCode','errorMessage')):raise Conflict('Terminal command is immutable')
            if old and status=='RECEIVED' and old['status'] not in {'CREATED','SENT','RECEIVED'}:raise Conflict('Command cannot accept start confirmation')
        if kind=='skillWorkbenchTask' and result.get('status') in {'pending','running'} and result.get('type') not in {'generation','evaluation','experiment','optimization','retest','publish'}:raise ValueError('Unknown workbench task type')
        if kind=='reliabilityClientCredential' and old and old.get('revokedAt') is not None and result.get('revokedAt')!=old.get('revokedAt'):raise Conflict('Credential revocation is retained')
        if kind=='reliabilityConfigSnapshot' and old and result!=old:raise Conflict('Config snapshots are immutable')
        return result

    def _lookup(self,kind,data):
        field=LOOKUPS.get(kind);value=data.get(field) if field else None
        if value is None:return None
        return value if field in {'tokenHash','credentialHash'} else hashlib.sha256(str(value).encode()).hexdigest()

    def _unique(self,kind,data):
        choices=[keys for keys in MODELS[kind]['unique'] if keys!=['id'] and keys!=[LOOKUPS.get(kind)]]
        if not choices:return None
        keys=max(choices,key=len)
        if any(data.get(key) is None for key in keys):return None
        return _hash([data[key] for key in keys])

    def _find_reference(self,con,workspace,kind,fields,values):
        if fields==['id']:return self._row(con,workspace,kind,values[0])
        lookup=LOOKUPS.get(kind)
        if len(fields)==1 and fields[0]==lookup:
            value=values[0] if lookup in {'tokenHash','credentialHash'} else hashlib.sha256(str(values[0]).encode()).hexdigest()
            row=con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND lookup_hash=? AND state='active'",(workspace,kind,value)).fetchone()
            return dict(row) if row else None
        rows=con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND state='active'",(workspace,kind)).fetchall()
        if len(rows)>MAX_RECORDS:raise StorageError('Control relation scope too large')
        return next((dict(row) for row in rows if all(json.loads(row['metadata_json']).get(field)==value for field,value in zip(fields,values))),None)

    def _parent(self,con,scope,grant,workspace,kind,data,*,historical=False):
        chosen=None
        for relation in MODELS[kind]['relations'].values():
            if not relation.get('fields'):continue
            values=[data.get(field) for field in relation['fields']]
            if any(value is None for value in values):continue
            target=self._find_reference(con,workspace,relation['model'],relation['references'],values)
            if target is None:raise Conflict('Control parent is unavailable')
            if not historical:assert_control_live(con,workspace,relation['model'],target['record_id'])
            if target['owner_principal_id']!=scope.principal_id:
                if relation['model']!='skill' or not self._can_read(con,scope,grant,target):raise Forbidden('Control parent belongs to another owner')
            if PARENT_PRIORITY.get(kind)==relation['model'] or chosen is None:chosen=(relation['model'],target['record_id'])
        return chosen or (None,None)

    def _metadata(self,kind,data):return {field:value for field,value in data.items() if not _body_field(field) and (kind not in SECRET_KINDS or field not in {'externalAccount'})}

    def _asset(self,con,scope,workspace,kind,data,oldrow,file_bundle=None):
        if kind=='skill':
            asset=oldrow.get('asset_id') if oldrow else None
            asset=asset or str(uuid.uuid5(uuid.NAMESPACE_URL,_json([workspace,scope.principal_id,'control-skill',data['id']])))
            name='control:'+scope.principal_id+':'+data['name'];now=self.control.clock()
            if oldrow:
                con.execute('UPDATE asset_identities SET name=?,visibility=?,description=?,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND asset_id=?',(name,'public' if data.get('visibility')=='public' else 'workspace' if data.get('visibility')=='team' else 'private',data.get('description') or '',now,workspace,asset))
            else:
                con.execute("INSERT INTO asset_identities(workspace_id,asset_id,kind,name,visibility,description,created_at_ms,updated_at_ms) VALUES(?,?,'skill',?,?,?,?,?)",(workspace,asset,name,'public' if data.get('visibility')=='public' else 'workspace' if data.get('visibility')=='team' else 'private',data.get('description') or '',now,now))
                self.iam._record_resource(con,workspace,'asset',asset,scope.principal_id,'group' if data.get('visibility') in {'public','team'} else 'private',invalidate_policy=data.get('visibility') in {'public','team'})
            if oldrow:
                visibility='group' if data.get('visibility') in {'public','team'} else 'private'
                resource=con.execute("SELECT visibility FROM iam_resource_access WHERE workspace_id=? AND resource_kind='asset' AND resource_id=?",(workspace,asset)).fetchone()
                if resource and resource[0]!=visibility:
                    con.execute("UPDATE iam_resource_access SET visibility=?,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND resource_kind='asset' AND resource_id=?",(visibility,now,workspace,asset));self.iam._touch_policy(con,workspace)
            return asset
        if kind=='skillVersion':
            parent=self._row(con,workspace,'skill',data['skillId'])
            if not parent or parent['owner_principal_id']!=scope.principal_id:raise Forbidden('Skill version owner differs')
            asset=parent['asset_id'];alias='version:'+str(data['version']);current=con.execute('SELECT etag FROM asset_aliases WHERE workspace_id=? AND asset_id=? AND alias=?',(workspace,asset,alias)).fetchone();generation=int(current[0])+1 if current else 1
            digest,ref=self.control.persist_artifact({'text':_json({'format':'platform-skill-files/v1','data':data,'files':file_bundle or []})})
            release=str(uuid.uuid5(uuid.NAMESPACE_URL,_json([workspace,asset,alias,generation,digest])));now=self.control.clock()
            con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',(workspace,release,asset,'control:'+str(data['version'])+':'+str(generation),digest,ref,scope.principal_id,now))
            con.execute('INSERT INTO asset_release_seals VALUES(?,?,?,0,?)',(workspace,release,asset,now))
            if current:con.execute('UPDATE asset_aliases SET release_id=?,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND asset_id=? AND alias=?',(release,now,workspace,asset,alias))
            else:con.execute('INSERT INTO asset_aliases VALUES(?,?,?,?,1,?,?)',(workspace,asset,alias,release,now,now))
            return asset
        return oldrow.get('asset_id') if oldrow else None

    def _put(self,con,scope,grant,workspace,username,operation,touched=None):
        if not isinstance(operation,dict) or set(operation)-{'kind','method','record_id','data','expected_revision','file_bundle'}:raise ValueError('Fixed control mutation required')
        kind=operation.get('kind');self._model(kind);method=operation.get('method')
        if touched is not None:touched.add(kind)
        if method not in {'create','update','delete'}:raise ValueError('Invalid control mutation')
        oldrow=self._row(con,workspace,kind,operation.get('record_id')) if method!='create' else None
        if not oldrow and method!='create' and self.capability and self.capability.get('peer'):
            candidate=self._row(con,self.capability['peer']['workspace'],kind,operation.get('record_id'))
            if candidate and self._peer_record(candidate):oldrow=candidate;workspace=candidate['workspace_id']
        if method!='create' and oldrow is None:raise Conflict('Control record unavailable')
        if oldrow and method!='delete':assert_control_live(con,workspace,kind,oldrow['record_id'])
        if oldrow and oldrow['owner_principal_id']!=scope.principal_id:
            if not self._peer_record(oldrow):raise Forbidden('Control write requires actual owner')
            scope=replace(scope,principal_id=oldrow['owner_principal_id']);username=oldrow['legacy_username']
        if oldrow and operation.get('expected_revision') is not None and _revision(operation['expected_revision'])!=oldrow['revision']:raise Conflict('Control record changed')
        if method=='delete':
            self.iam._workspace(scope,workspace,'delete')
            self._delete(con,workspace,kind,oldrow,touched);return self._data(oldrow)
        old=self._data(oldrow) if oldrow else None;data=self._normalize(kind,operation.get('data'),username,old)
        identity=identifier(data['id']);existing=self._row(con,workspace,kind,identity,True)
        if method=='create' and existing:raise Conflict('Control identity exists; use a new internal record identity')
        parent=self._parent(con,scope,grant,workspace,kind,data)
        if oldrow and parent!=(oldrow['parent_kind'],oldrow['parent_id']):raise Conflict('Control parent cannot change')
        if kind=='reliabilityCommand' and method=='create' and data.get('action') in {'RUN_EXPERIMENT_CASE','RUN_BENCHMARK_CASE','START_FI_RUN'}:self.iam._workspace(scope,workspace,'execute')
        if kind=='skillWorkbenchTask' and data.get('status') in {'pending','running'}:
            active=con.execute("SELECT record_id,metadata_json FROM platform_control_records WHERE workspace_id=? AND owner_principal_id=? AND kind='skillWorkbenchTask' AND parent_id=? AND state='active' AND status IN ('pending','running')",(workspace,scope.principal_id,data['sessionId'])).fetchall()
            if any(item['record_id']!=identity and not is_historical_control(con,workspace,kind,item['record_id']) and json.loads(item['metadata_json']).get('type')==data['type'] for item in active):raise Conflict('Workbench task type is already active')
        for fields in MODELS[kind]['unique']:
            if fields==['id'] or any(data.get(field) is None for field in fields):continue
            candidates=con.execute("SELECT * FROM platform_control_records WHERE kind=? AND state='active'"+(" AND workspace_id=? AND owner_principal_id=?" if kind!='user' else ''),(kind,workspace,scope.principal_id) if kind!='user' else (kind,)).fetchall()
            if len(candidates)>MAX_RECORDS:raise StorageError('Unique control scope exceeds budget')
            for candidate in candidates:
                if candidate['record_id']==identity and candidate['workspace_id']==workspace:continue
                values=json.loads(candidate['metadata_json'])
                if any(field not in values for field in fields):values=self._data(dict(candidate))
                if all(values.get(field)==data[field] for field in fields):raise Conflict('Control unique key exists')
        unique=self._unique(kind,data);lookup=self._lookup(kind,data)
        if unique and con.execute("SELECT 1 FROM platform_control_records WHERE workspace_id=? AND kind=? AND owner_principal_id=? AND unique_key=? AND record_id<>? AND state='active'",(workspace,kind,scope.principal_id,unique,identity)).fetchone():raise Conflict('Control unique key exists')
        if lookup and con.execute('SELECT 1 FROM platform_control_records WHERE kind=? AND lookup_hash=? AND NOT(workspace_id=? AND record_id=?)',(kind,lookup,workspace,identity)).fetchone():raise Conflict('Control lookup identity exists')
        files=self._validate_files(operation['file_bundle']) if kind=='skillVersion' and 'file_bundle' in operation else self._file_bundle(oldrow) if kind=='skillVersion' and oldrow else []
        asset=self._asset(con,scope,workspace,kind,data,oldrow,files);digest,ref=self._persist({'format':'platform-skill-files/v1','data':data,'files':files} if kind=='skillVersion' else data);now=self.control.clock();sort=_ms(data.get('updatedAt') or data.get('createdAt') or now)
        if not oldrow:sort=max(sort,(con.execute('SELECT MAX(sort_ms) FROM platform_control_records WHERE workspace_id=? AND kind=? AND owner_principal_id=?',(workspace,kind,scope.principal_id)).fetchone()[0] or 0)+1)
        elif kind in {'skillWorkbenchMessage','skillGeneratorMessage','skillOptMessage'}:sort=oldrow['sort_ms']
        metadata=_json(self._metadata(kind,data))
        if oldrow:
            con.execute('UPDATE platform_control_records SET unique_key=?,lookup_hash=?,status=?,expires_at_ms=?,sort_ms=?,metadata_json=?,payload_hash=?,payload_ref=?,asset_id=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND kind=? AND record_id=?',(unique,lookup,data.get('status'),_ms(data['expiresAt']) if data.get('expiresAt') else None,sort,metadata,digest,ref,asset,now,workspace,kind,identity))
        else:
            con.execute('INSERT INTO platform_control_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(workspace,kind,identity,scope.principal_id,username,*parent,unique,lookup,data.get('status'),_ms(data['expiresAt']) if data.get('expiresAt') else None,sort,metadata,digest,ref,asset,'active',1,now,now))
        return data

    def _delete(self,con,workspace,kind,row,touched=None):
        if touched is not None:touched.add(kind)
        if row['state']!='active':return
        original=self._data(row)
        for childkind,model in MODELS.items():
            for relation in model['relations'].values():
                if relation.get('model')!=kind or not relation.get('fields'):continue
                expected=[original.get(field) for field in relation['references']]
                candidates=con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND state='active'",(workspace,childkind)).fetchall()
                if len(candidates)>MAX_RECORDS:raise StorageError('Control cascade exceeds scope')
                for child in candidates:
                    values=json.loads(child['metadata_json'])
                    if all(values.get(field)==value for field,value in zip(relation['fields'],expected)):
                        if not relation.get('cascade'):raise Conflict('Control parent has retained dependent records')
                        self._delete(con,workspace,childkind,dict(child),touched)
        con.execute("UPDATE platform_control_records SET state='deleted',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND kind=? AND record_id=?",(self.control.clock(),workspace,kind,row['record_id']))

    def _read(self,con,scope,grant,workspace,body,private,owner_only=False,preparation=False,live_only=False):
        allowed={'kind','ids','parents','metadata','fields','body','owner_username'}
        if set(body)-allowed:raise ValueError('Fixed control selector required')
        kind=body.get('kind');model=self._model(kind);fields=body.get('fields',[])
        if not isinstance(fields,list) or any(field not in model['fields'] for field in fields):raise ValueError('Invalid control projection')
        if kind=='user' and (body.get('body') or 'apiKey' in fields):raise Forbidden('Stored API keys are available only through the verified login bootstrap')
        if kind in SECRET_KINDS and (body.get('body') or any(_body_field(field) for field in fields)) and not private:raise Forbidden('Private owner control read required')
        query="SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND state='active'";params=[workspace,kind]
        peer=self.capability.get('peer') if self.capability else None
        if peer and kind in {'reliabilityClient','reliabilityClientCredential'}:
            query="SELECT * FROM platform_control_records WHERE workspace_id IN (?,?) AND kind=? AND state='active'";params=[workspace,peer['workspace'],kind]
        if body.get('ids') is not None:
            ids=body['ids']
            if not isinstance(ids,list) or len(ids)>MAX_RECORDS or any(not isinstance(value,str) for value in ids):raise ValueError('Bounded control ids required')
            if not ids:return {'rows':[],'scope_revision':str(self._scope_revision(con,workspace,scope.principal_id,kind))}
            query+=' AND record_id IN ('+','.join('?' for _ in ids)+')';params+=ids
        if body.get('parents') is not None:
            parents=body['parents']
            if not isinstance(parents,list) or not parents or len(parents)>MAX_RECORDS:raise ValueError('Bounded control parents required')
            query+=' AND parent_id IN ('+','.join('?' for _ in parents)+')';params+=parents
        if owner_only and kind not in {'skill','skillVersion'} or kind in SECRET_KINDS:
            peer=self.capability.get('peer') if self.capability else None
            if peer and kind in {'reliabilityClient','reliabilityClientCredential'}:query+=' AND owner_principal_id IN (?,?)';params.extend([scope.principal_id,peer['owner']])
            else:query+=' AND owner_principal_id=?';params.append(scope.principal_id)
        if body.get('owner_username') is not None and not (self.capability and self.capability.get('peer') and kind in {'reliabilityClient','reliabilityClientCredential'}):query+=' AND legacy_username=?';params.append(identifier(body['owner_username']))
        rows=con.execute(query+' ORDER BY sort_ms,record_id',tuple(params)).fetchall()
        if len(rows)>MAX_RECORDS:raise StorageError('Control selector exceeds record budget')
        metadata=body.get('metadata',{})
        if not isinstance(metadata,dict) or any(field not in model['fields'] or _body_field(field) for field in metadata):raise ValueError('Fixed control metadata selector required')
        if kind=='skillVersion' and body.get('body') and not body.get('ids') and not body.get('parents') and not metadata.get('skillId'):raise Forbidden('Selected Skill versions required')
        result=[];found_denied=False
        for raw in rows:
            row=dict(raw)
            if (live_only or self.capability or getattr(self,'live_only',False)) and is_historical_control(con,workspace,kind,row['record_id']):continue
            if not self._can_read(con,scope,grant,row,private=kind in SECRET_KINDS,preparation=preparation):found_denied=True;continue
            data=json.loads(row['metadata_json'])
            if any(data.get(field) not in value if isinstance(value,list) else data.get(field)!=value for field,value in metadata.items()):continue
            if body.get('body'):data=self._data(row)
            elif fields and any(field not in data for field in fields):
                full=self._data(row)
                for field in fields:
                    if field in full:data[field]=full[field]
            result.append({'record_id':row['record_id'],'revision':str(row['revision']),'owner_principal_id':row['owner_principal_id'],'data':data,**({'file_bundle':self._file_bundle(row)} if kind=='skillVersion' and (body.get('body') or any(field in {'files','assetPath'} for field in fields)) else {})})
        if body.get('ids') and not result and (found_denied or any(self._row(con,workspace,kind,identity) and not ((live_only or self.capability or getattr(self,'live_only',False)) and is_historical_control(con,workspace,kind,identity)) for identity in body['ids'])):raise Forbidden('Control record belongs to another actor')
        if len(_json(result).encode())>MAX_BYTES:raise StorageError('Control response exceeds byte budget')
        return {'rows':result,'scope_revision':str(self._scope_revision(con,workspace,scope.principal_id,kind))}

    def dispatch(self,token,workspace,action,body,*,trusted=False,preparation=False,write_prior=False):
        if not isinstance(body,dict):raise ValueError('Control object required')
        body=copy.deepcopy(body);required=body.pop('required_capabilities',[])
        if not isinstance(required,list) or any(cap not in ('read','write','execute','publish','delete') for cap in required):raise ValueError('Fixed control capabilities required')
        if required:
            with self.control.read_transaction() as con:
                for cap in required:self._scope(con,token,workspace,cap)
        if action=='scope':
            if set(body)!={'capabilities'} or not isinstance(body['capabilities'],list) or not body['capabilities']:raise ValueError('Control capabilities required')
            with self.control.read_transaction() as con:
                for capability in body['capabilities']:
                    if capability not in ('read','write','execute'):raise ValueError('Invalid control capability')
                    scope,_=self._scope(con,token,workspace,capability)
                return {'authorized':True,'principal_id':scope.principal_id,'workspace_id':workspace}
        if action=='agent_delete':
            if not trusted or preparation or write_prior or self.capability:raise Forbidden('Verified Agent deletion producer required')
            if set(body)!={'agent_id','trace_ids'} or not isinstance(body['trace_ids'],list) or len(body['trace_ids'])>MAX_RECORDS:raise ValueError('Bounded Agent deletion required')
            from .trace_metadata import TraceMetadata
            with self.control.transaction() as con:
                scope,grant=self._scope(con,token,workspace,'delete');self.iam._workspace(scope,workspace,'write')
                agent=self._row(con,workspace,'registeredAgent',identifier(body['agent_id']))
                if not agent:return {'deletedTraces':0}
                if agent['owner_principal_id']!=scope.principal_id:raise Forbidden('Agent deletion requires actual owner')
                metadata=TraceMetadata(self.control);count=0;now=self.control.clock()
                for trace in dict.fromkeys(body['trace_ids']):
                    trace=identifier(trace);_,locator=metadata._trace(con,token,workspace,trace,'delete',allow_retired=True)
                    access=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,trace)).fetchone()
                    if not access or access[0]!=scope.principal_id:raise Forbidden('Agent Trace owner differs')
                    if locator['state']!='active':continue
                    if metadata._delete(con,token,workspace,trace):count+=1
                self._delete(con,workspace,'registeredAgent',agent);self._bump_scope(con,workspace,scope.principal_id,agent['legacy_username'],'registeredAgent')
                return {'deletedTraces':count}
        if action=='records_read':
            with self.control.read_transaction() as con:
                capability='write' if preparation or write_prior else 'read';scope,grant=self._scope(con,token,workspace,capability)
                if preparation and (not trusted or body.get('kind') not in PREPARATION_KINDS):raise Forbidden('Collector preparation read is restricted')
                return self._read(con,scope,grant,workspace,body,trusted,owner_only=write_prior or preparation,preparation=preparation,live_only='execute' in required)
        if action!='records_batch' or not trusted:raise Forbidden('Private control mutation required')
        if set(body)-{'legacy_username','operation_key','operations','expected_scope_revision','expected_kind_revisions'}:raise ValueError('Fixed control batch required')
        username=identifier(body.get('legacy_username'));key=identifier(body.get('operation_key'));operations=body.get('operations')
        if not isinstance(operations,list) or len(operations)>2000:raise ValueError('Bounded control mutations required')
        digest=_hash(body);receipt_id=_hash(['platform-controls',key]);now=self.control.clock()
        with self.control.transaction() as con:
            scope,grant=self._scope(con,token,workspace,'write');source='platform-controls:'+scope.principal_id
            prior=con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(workspace,source,receipt_id)).fetchone()
            if prior:
                if prior[0]!=digest:raise Conflict('Control operation key differs')
                receipt=self._row(con,workspace,'_receipt',receipt_id);saved=self._data(receipt) if receipt else None
                if not saved:raise StorageError('Control receipt result missing')
                return {**saved,'duplicate':True}
            current=self._scope_revision(con,workspace,scope.principal_id)
            if body.get('expected_scope_revision') is not None and _revision(body['expected_scope_revision'])!=current:raise Conflict('Control scope changed')
            expected=body.get('expected_kind_revisions',{})
            if not isinstance(expected,dict):raise ValueError('Control kind revisions required')
            for kind,version in expected.items():
                self._model(kind)
                if _revision(version)!=self._scope_revision(con,workspace,scope.principal_id,kind):raise Conflict('Control kind changed')
            touched=set();result=[self._put(con,scope,grant,workspace,username,operation,touched) for operation in operations]
            peer=self.capability.get('peer') if self.capability else None
            if peer:
                previous=self._row(con,peer['workspace'],'reliabilityClient',peer['client_record_id'])
                if previous and self._data(previous).get('unboundAt'):
                    oldscope=replace(scope,principal_id=peer['owner']);olduser=previous['legacy_username']
                    credentials=con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind='reliabilityClientCredential' AND owner_principal_id=? AND state='active'",(peer['workspace'],peer['owner'])).fetchall()
                    for credential in credentials:
                        prior=self._data(dict(credential))
                        if prior['clientId']==peer['client_id'] and prior['revokedAt'] is None:self._put(con,oldscope,grant,peer['workspace'],olduser,{'kind':'reliabilityClientCredential','method':'update','record_id':credential['record_id'],'data':{'revokedAt':_iso(now)}})
                    for kind in ('reliabilityClient','reliabilityClientCredential'):self._bump_scope(con,peer['workspace'],peer['owner'],olduser,kind)
            for kind in touched:self._bump_scope(con,workspace,scope.principal_id,username,kind)
            version=self._bump_scope(con,workspace,scope.principal_id,username)
            saved={'duplicate':False,'results':result,'scope_revision':str(version)};result_hash,result_ref=self._persist(saved)
            con.execute('INSERT INTO platform_control_records(workspace_id,kind,record_id,owner_principal_id,legacy_username,sort_ms,metadata_json,payload_hash,payload_ref,state,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(workspace,'_receipt',receipt_id,scope.principal_id,username,now,_json({'operation_hash':digest}),result_hash,result_ref,'active',1,now,now))
            con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',(workspace,source,receipt_id,digest,now))
            return saved

    def bootstrap_login(self,body):
        from .iam import _login_name, ROLE_CAPABILITIES
        if set(body)-{'action','username','mode','external_account'} or body.get('action')!='login' or body.get('mode') not in {'standalone','organization','idaas_oauth'}:raise ValueError('Verified legacy login assertion required')
        username=identifier(body.get('username'));now=self.control.clock()
        try:login=_login_name(username)
        except ValueError:login='legacy_'+hashlib.sha256(username.encode()).hexdigest()
        with self.control.transaction() as con:
            aliases=con.execute("SELECT * FROM platform_control_records WHERE kind='user' AND unique_key=? AND state='active'",(_hash([username]),)).fetchall()
            if len(aliases)>1:raise Conflict('Ambiguous legacy login')
            if aliases:
                record=dict(aliases[0]);data=self._data(record)
                if data['username']!=username or not data['apiKey'].startswith('api_'):raise Forbidden('Verified legacy login binding required')
                current=self.iam._scope(con,data['apiKey']);self.iam._workspace(current,record['workspace_id'],'read')
                if current.principal_id!=record['owner_principal_id']:raise Forbidden('Legacy login owner differs')
                return {**data,'_created':False}
            principal=con.execute('SELECT principal_id,status,auth_version FROM iam_principals WHERE normalized_login_name=?',(login,)).fetchone()
            if principal and principal['status']!='active':raise Forbidden('Principal is not active')
            owner=principal['principal_id'] if principal else str(uuid.uuid5(uuid.NAMESPACE_URL,'platform-user:'+login))
            old=con.execute("SELECT * FROM platform_control_records WHERE owner_principal_id=? AND kind='user' AND state='active'",(owner,)).fetchall()
            if len(old)>1:raise Conflict('Ambiguous legacy login')
            if old:
                data=self._data(dict(old[0]))
                if data['username']!=username:raise Forbidden('Legacy username differs')
                # Retain the existing key and its existing capability/expiry/revocation contract.
                if data['apiKey'].startswith('api_'):self.iam._authenticate(con,data['apiKey'])
                return {**data,'_created':False}
            if not principal:con.execute("INSERT INTO iam_principals VALUES(?,?,?,'active',1,?,?)",(owner,login,username,now,now))
            binding=con.execute("SELECT workspace_id FROM iam_workspace_bindings WHERE owner_type='personal' AND owner_principal_id=?",(owner,)).fetchall()
            if len(binding)>1:raise Conflict('Ambiguous personal workspace')
            workspace=binding[0][0] if binding else str(uuid.uuid5(uuid.NAMESPACE_URL,'platform-personal:'+owner))
            if not binding:
                project=con.execute("SELECT status FROM projects WHERE project_id='default'").fetchone()
                if not project or project[0]!='active':raise Forbidden('Default project unavailable')
                con.execute('INSERT INTO workspaces(workspace_id,name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)',(workspace,'Personal',now,now))
                con.execute("INSERT INTO project_workspaces VALUES(?,'default',?)",(workspace,now))
                con.execute("INSERT INTO iam_workspace_bindings VALUES(?,'personal',NULL,?,1,?,?)",(workspace,owner,now,now))
            token='api_'+secrets.token_urlsafe(32);version=principal['auth_version'] if principal else 1
            con.execute('INSERT INTO iam_api_credentials VALUES(?,?,?,?,?,?,?,?,NULL)',(str(uuid.uuid4()),owner,workspace,hashlib.sha256(token.encode()).hexdigest(),_json(sorted(ROLE_CAPABILITIES['personal'])),version,now,now+31_536_000_000))
            scope,grant=self._scope(con,token,workspace,'write')
            data=self._put(con,scope,grant,workspace,username,{'kind':'user','method':'create','data':{'username':username,'apiKey':token,'externalAccount':body.get('external_account')}})
            self._bump_scope(con,workspace,owner,username,'user')
            return {**data,'_created':True}

    def _capability_scope(self,con):
        from .iam import _capabilities
        cap=self.capability;typ=cap.get('type')
        if typ not in {'device','install'}:raise Forbidden('Actual device or installation capability required')
        field='credential_hash' if typ=='device' else 'token_hash';value=cap.get(field)
        if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):raise Forbidden('Invalid capability proof')
        kind='reliabilityClientCredential' if typ=='device' else 'reliabilityInstallToken'
        row=con.execute("SELECT * FROM platform_control_records WHERE kind=? AND lookup_hash=? AND state='active'",(kind,value)).fetchone()
        if not row:raise Forbidden('Capability unavailable')
        row=dict(row)
        if is_historical_control(con,row['workspace_id'],kind,row['record_id']):raise Forbidden('Historical capability is inactive')
        data=self._data(row)
        if typ=='device':
            if data.get('revokedAt') is not None:raise Forbidden('Device credential revoked')
            client=self._find_reference(con,row['workspace_id'],'reliabilityClient',['clientId'],[data['clientId']])
            if not client or client['owner_principal_id']!=row['owner_principal_id']:raise Forbidden('Device owner differs')
            if is_historical_control(con,row['workspace_id'],'reliabilityClient',client['record_id']):raise Forbidden('Historical device is inactive')
            clientdata=json.loads(client['metadata_json'])
            if clientdata.get('unboundAt') or clientdata.get('status') in {'unbound','disabled'}:raise Forbidden('Device unavailable')
            if cap.get('client_id') and cap['client_id']!=data['clientId']:raise Forbidden('Device client differs')
            cap['client_id']=data['clientId'];cap['client_record_id']=client['record_id'];cap['credential_record_id']=row['record_id']
        elif data.get('consumedAt') is not None or _ms(data['expiresAt'])<=self.control.clock():raise Forbidden('Installation token expired or consumed')
        if typ=='install' and cap.get('previous_credential_hash'):
            previous=self.capability;self.capability={'type':'device','credential_hash':cap['previous_credential_hash']}
            try:
                _,peer=self._capability_scope(con);cap['peer']={'client_id':self.capability['client_id'],'client_record_id':self.capability['client_record_id'],'owner':peer['owner_principal_id'],'workspace':peer['workspace_id']}
            except Forbidden:cap.pop('peer',None)
            finally:self.capability=previous
        principal=con.execute("SELECT * FROM iam_principals WHERE principal_id=? AND status='active'",(row['owner_principal_id'],)).fetchone()
        if not principal:raise Forbidden('Capability owner unavailable')
        scope=self.iam._scope_authenticated(con,{'principal_id':row['owner_principal_id'],'workspace_id':row['workspace_id'],'capabilities_json':_json(['read','write']),'current_auth_version':principal['auth_version'],'credential_id':value},True)
        self.iam._workspace(scope,row['workspace_id'],'write')
        return scope,row

    def capability_dispatch(self,body):
        if not isinstance(body,dict):raise ValueError('Control capability object required')
        value=copy.deepcopy(body);cap=value.pop('capability',None)
        if not isinstance(cap,dict) or set(cap)-{'type','credential_hash','client_id','token_hash','previous_credential_hash'}:raise ValueError('Fixed device capability required')
        self.capability=cap
        with self.control.transaction() as con:
            scope,row=self._capability_scope(con);workspace=row['workspace_id'];username=row['legacy_username'];client=cap.get('client_id')
            if value.get('action')=='identity':
                if cap['type']=='device':
                    self._put(con,scope,self.iam._workspace(scope,workspace,'write'),workspace,username,{'kind':'reliabilityClientCredential','method':'update','record_id':row['record_id'],'data':{'lastUsedAt':_iso(self.control.clock())}})
                    self._bump_scope(con,workspace,scope.principal_id,username,'reliabilityClientCredential')
                return {'principal':scope.principal_id,'workspace':workspace,'username':username,'client_id':client}
            action=value.pop('action',None);value.pop('access',None);value.pop('required_capabilities',None)
            kinds={'reliabilityClient','reliabilityClientCredential','reliabilityCommand','reliabilityClientConfig','reliabilityConfigSnapshot','reliabilityConfigDelivery','reliabilityConfigLoad','skillDeployment','skillDeploymentEvent'} if cap['type']=='device' else {'reliabilityInstallToken','reliabilityClient','reliabilityClientCredential'}
            if action=='scope':raise Forbidden('Device cannot become an execution actor')
            if action=='records_read':
                kind=value.get('kind')
                if kind not in kinds:raise Forbidden('Capability control kind is restricted')
                value['owner_username']=username
                if cap['type']=='device':
                    metadata=value.setdefault('metadata',{})
                    if kind=='reliabilityClient':value['ids']=[cap['client_record_id']]
                    elif kind=='reliabilityClientCredential':value['ids']=[cap['credential_record_id']]
                    elif kind not in {'reliabilityConfigSnapshot','skillDeploymentEvent','reliabilityConfigLoad'}:metadata['clientId']=client
                    elif not value.get('ids') and not metadata:raise Forbidden('Selected device dependency required')
                elif kind=='reliabilityInstallToken':value['ids']=[row['record_id']]
            elif action=='records_batch':
                if value.get('legacy_username')!=username:raise Forbidden('Capability owner label differs')
                for operation in value.get('operations',[]):
                    kind=operation.get('kind')
                    if kind not in kinds:raise Forbidden('Capability mutation kind is restricted')
                    current=self._row(con,workspace,kind,operation.get('record_id')) if operation.get('method')!='create' else None
                    if not current and cap.get('peer') and operation.get('method')!='create':
                        candidate=self._row(con,cap['peer']['workspace'],kind,operation.get('record_id'))
                        if candidate and self._peer_record(candidate):current=candidate
                    data=operation.get('data',{})
                    if current and current['owner_principal_id']!=scope.principal_id and not self._peer_record(current):raise Forbidden('Capability mutation owner differs')
                    prior=self._data(current) if current else {}
                    if cap['type']=='device':
                        if operation.get('method')=='delete':raise Forbidden('Device cannot delete controls')
                        if kind=='reliabilityClient':
                            if not current or current['record_id']!=cap['client_record_id'] or any(data.get(field,prior.get(field))!=prior.get(field) for field in ('id','clientId','user','machineId','unboundAt','unboundToClientId')):raise Forbidden('Device identity is immutable')
                        elif kind=='reliabilityClientCredential':
                            if not current or current['record_id']!=cap['credential_record_id'] or any(data.get(field,prior.get(field))!=prior.get(field) for field in ('id','clientId','credentialHash','revokedAt')):raise Forbidden('Device credential is immutable')
                        elif kind in {'reliabilityCommand','reliabilityConfigDelivery','skillDeployment'}:
                            if not current or prior.get('clientId')!=client or data.get('clientId',prior.get('clientId'))!=client:raise Forbidden('Device control target differs')
                            immutable={'reliabilityCommand':['action','payloadJson','expiresAt','user','commandId'],'reliabilityConfigDelivery':['configRef','user','deliveryId'],'skillDeployment':['user','deploymentId','targetJson','artifactJson','commandId','skillName','skillVersion']}[kind]
                            if any(data.get(field,prior.get(field))!=prior.get(field) for field in immutable if field in prior):raise Forbidden('Device control definition is immutable')
                        elif kind in {'reliabilityClientConfig','reliabilityConfigSnapshot'}:raise Forbidden('Device cannot edit published configuration')
                        elif data.get('clientId',client)!=client:raise Forbidden('Device target differs')
                    elif current and self._peer_record(current):
                        changed={field for field,value in data.items() if value!=prior.get(field)}
                        allowed={'unboundAt','unboundToClientId','status','updatedAt'} if kind=='reliabilityClient' else {'revokedAt'}
                        if operation.get('method')!='update' or changed-allowed or kind=='reliabilityClient' and (not data.get('unboundAt') or data.get('status')!='offline') or kind=='reliabilityClientCredential' and not data.get('revokedAt'):raise Forbidden('Old device proof permits only atomic handoff revocation')
                    elif kind=='reliabilityInstallToken' and (not current or current['record_id']!=row['record_id'] or any(data.get(field,prior.get(field))!=prior.get(field) for field in ('id','user','tokenHash','expiresAt'))):raise Forbidden('Installation token identity differs')
            else:raise ValueError('Fixed capability action required')
        return self.dispatch('internal-capability',workspace,action,value,trusted=True,write_prior=action=='records_read')

    def _peer_record(self,row):
        cap=self.capability
        if not cap or cap.get('type')!='install' or not cap.get('peer') or row['workspace_id']!=cap['peer']['workspace'] or row['owner_principal_id']!=cap['peer']['owner']:return False
        data=json.loads(row['metadata_json'])
        return row['kind']=='reliabilityClient' and row['record_id']==cap['peer']['client_record_id'] or row['kind']=='reliabilityClientCredential' and data.get('clientId')==cap['peer']['client_id']

    def _device_visible(self,con,row):
        cap=self.capability;kind=row['kind'];data=json.loads(row['metadata_json']);client=cap['client_id']
        if kind=='reliabilityClient':return row['record_id']==cap['client_record_id']
        if kind=='reliabilityClientCredential':return row['record_id']==cap['credential_record_id']
        if 'clientId' in data:return data['clientId']==client
        if kind=='reliabilityConfigSnapshot':
            deliveries=con.execute("SELECT metadata_json FROM platform_control_records WHERE workspace_id=? AND owner_principal_id=? AND kind='reliabilityConfigDelivery' AND state='active'",(row['workspace_id'],row['owner_principal_id'])).fetchall()
            return any((lambda entry:entry.get('clientId')==client and entry.get('configRef')==data.get('configRef'))(json.loads(item[0])) for item in deliveries)
        if kind=='skillDeploymentEvent':
            deployment=self._find_reference(con,row['workspace_id'],'skillDeployment',['deploymentId'],[data.get('deploymentId')])
            return deployment is not None and json.loads(deployment['metadata_json']).get('clientId')==client
        return False
