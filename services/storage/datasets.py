"""Dataset DTOs backed by immutable assets and live workspace authorization."""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from .contracts import canonical_json, identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden

MAX_DATASET_BYTES=64*1024*1024
MAX_CASE_BYTES=16*1024*1024
MAX_CASES=100000
MAX_METADATA_BYTES=1024*1024
MAX_VERSIONS=1000
MAX_DATASETS=2000
PUBLIC_KEYS={'id','input','tags','source','traceSource'}
PUBLIC_VALUES={'input','available_tools','available_skills'}


class DatasetNotFound(StorageError):
    status=404


class DatasetTooLarge(ValueError):
    status=413


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _bounded(value,maximum):
    size=0
    for part in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).iterencode(value):
        size+=len(part.encode('utf-8'))
        if size>maximum: raise DatasetTooLarge('Dataset exceeds bounded size')
    return size


def _number(value):
    if isinstance(value,str) and re.fullmatch('[1-9][0-9]{0,18}',value): value=int(value)
    return revision(value)


def _iso(value):
    return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


class DatasetStore:
    not_found=DatasetNotFound
    too_large=DatasetTooLarge

    def __init__(self,control):
        self.control=control; self.iam=IAMStore(control)
        with control.read_transaction() as con:
            if con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0]<8: raise StorageError('dataset migration 008 required')

    def _store(self,value,namespace):
        digest,ref=self.control.persist_artifact({'encoding':'dataset-json/v1','json':_json(value)})
        return {'hash':digest,'ref':ref,'namespace':namespace,'size':Path(ref).stat().st_size}

    def _load(self,digest,ref,limit=MAX_DATASET_BYTES):
        path=Path(ref); directory=self.control.artifact_directory
        if path.parent!=directory or path.name!=digest or not re.fullmatch('[0-9a-f]{64}',digest) or directory.is_symlink(): raise StorageError('Invalid private Dataset artifact')
        maximum=limit*6+4096
        try:
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as source:
                info=os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size>maximum: raise DatasetTooLarge('Dataset artifact exceeds budget')
                raw=source.read(maximum+1)
            if len(raw)>maximum or hashlib.sha256(raw).hexdigest()!=digest: raise StorageError('Dataset artifact checksum differs')
            wrapper=json.loads(raw.decode('utf-8'))
            if wrapper.get('encoding')!='dataset-json/v1' or not isinstance(wrapper.get('json'),str): raise ValueError()
            if len(wrapper['json'].encode('utf-8'))>limit: raise DatasetTooLarge('Dataset artifact expands beyond budget')
            result=json.loads(wrapper['json'],parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            _bounded(result,limit); return result
        except (OSError,ValueError,TypeError,KeyError,UnicodeError,RecursionError) as exc:
            if isinstance(exc,DatasetTooLarge): raise
            raise StorageError('Dataset artifact unavailable') from None

    @staticmethod
    def _clean(record):
        if not isinstance(record,dict): raise ValueError('Dataset object required')
        return {key:copy.deepcopy(value) for key,value in record.items() if key not in {'user','createdAt','updatedAt','_storageEtag','shared','readOnly'}}

    def _prepare_record(self,record,*,source_provenance=None):
        value=self._clean(record); request=copy.deepcopy(value); _bounded(value,MAX_DATASET_BYTES)
        identifier(value.get('id')); identifier(value.get('name'))
        for key,default in [('description',''),('targetAgent',''),('targetSkill',''),('tags',[]),('fields',[]),('cases',[]),('datasetKind','ideal_output')]: value.setdefault(key,copy.deepcopy(default))
        if value['datasetKind'] not in {'ideal_output','trajectory','reliability','benchmark'}: raise ValueError('Invalid Dataset kind')
        if any(not isinstance(value[key],str) for key in ('description','targetAgent','targetSkill')) or not isinstance(value['tags'],list) or any(not isinstance(tag,str) for tag in value['tags']): raise ValueError('Invalid Dataset metadata')
        if not isinstance(value['fields'],list) or not isinstance(value['cases'],list) or len(value['cases'])>MAX_CASES: raise ValueError('Bounded Dataset fields/cases required')
        fields=set()
        for field in value['fields']:
            if not isinstance(field,dict) or not isinstance(field.get('key'),str) or not field['key'] or field['key'] in fields or field.get('type') not in {'text','number','boolean','json'}: raise ValueError('Invalid or duplicate Dataset field')
            fields.add(field['key'])
        members=[]; artifacts=[]; cases=set()
        for case in value['cases']:
            if not isinstance(case,dict): raise ValueError('Dataset Case object required')
            identifier(case.get('id'))
            if case['id'] in cases: raise ValueError('Duplicate Dataset Case identity')
            cases.add(case['id']); _bounded(case,MAX_CASE_BYTES)
            if any(key in case and not isinstance(case[key],str) for key in ('input','expectedOutput','evaluationFocus','trajectory')): raise ValueError('Dataset Case text fields required')
            if 'values' in case and not isinstance(case['values'],dict): raise ValueError('Dataset Case values object required')
            source=case.get('traceSource')
            if source is not None:
                if not isinstance(source,dict) or not any(source.get(key) for key in ('taskId','executionId')): raise ValueError('Trace source identity required')
                for key in ('taskId','executionId'):
                    if key in source: identifier(source[key])
        metadata={key:value for key,value in value.items() if key!='cases'}; _bounded(metadata,MAX_METADATA_BYTES)
        # All members are validated before any payload is persisted.
        for ordinal,case in enumerate(value['cases']):
            public={key:copy.deepcopy(item) for key,item in case.items() if key in PUBLIC_KEYS}
            gold={key:copy.deepcopy(item) for key,item in case.items() if key not in PUBLIC_KEYS and key!='values'}
            if isinstance(case.get('traceSource'),dict):
                public['traceSource']={key:copy.deepcopy(item) for key,item in case['traceSource'].items() if key in {'taskId','executionId','capturedAt'}}
                if public['traceSource']!=case['traceSource']: gold['traceSource']=copy.deepcopy(case['traceSource'])
            if isinstance(case.get('values'),dict):
                public_values={key:copy.deepcopy(item) for key,item in case['values'].items() if key in PUBLIC_VALUES}
                gold['values']={key:copy.deepcopy(item) for key,item in case['values'].items() if key not in PUBLIC_VALUES}
                public['values']=public_values
            pub=self._store(public,'dataset.public'); private=self._store(gold,'dataset.gold'); artifacts.extend([pub,private])
            items=copy.deepcopy(case)
            for key in ('trajectory',):
                if isinstance(items.get(key),str) and len(items[key])>600: items[key]=items[key][:600]+'…'
            if isinstance(items.get('values'),dict):
                for key in ('trace','trajectory'):
                    if key in items['values']:
                        text=items['values'][key] if isinstance(items['values'][key],str) else _json(items['values'][key])
                        items['values'][key]=text if len(text)<=600 else text[:600]+'…'
            item_artifact=self._store(items,'dataset.items'); artifacts.append(item_artifact)
            reference=self._store({key:case.get(key,[] if key=='tags' else '') for key in ('id','input','expectedOutput','evaluationFocus','tags')},'dataset.reference'); artifacts.append(reference)
            member={'case_key':case['id'],'ordinal':ordinal,'public':pub,'private':private,'items':item_artifact,'reference':reference,'content_hash':_hash(case)}
            if case.get('traceSource') is not None: member['trace_source']=copy.deepcopy(case['traceSource'])
            members.append(member)
        manifest={'format':'agent-insight.dataset','version':1,'metadata':metadata,'members':members,'source_provenance':source_provenance or {}}
        _bounded(manifest,MAX_DATASET_BYTES)
        root=self._store(manifest,'dataset.members'); artifacts.append(root)
        return {'record':value,'request':request,'manifest':manifest,'root':root,'artifacts':artifacts}

    def _source_proof(self,con,token,ws,source):
        traces=set()
        for key in ('taskId','executionId'):
            ref=source.get(key)
            if ref is None: continue
            identifier(ref)
            matches={row[0] for row in con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(ws,ref))}
            if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,ref)).fetchone(): matches.add(ref)
            if not matches: raise Forbidden('Dataset Trace source unavailable')
            if len(matches)!=1: raise Conflict('Ambiguous Dataset Trace source')
            traces.update(matches)
        if len(traces)!=1: raise Conflict('Dataset Trace source identities differ')
        trace=next(iter(traces)); scope=self.iam._authorize(con,token,ws,'read','trace',trace)
        route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if route is None or route['state']!='active' or con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(ws,trace,route['incarnation'])).fetchone(): raise Conflict('Dataset Trace source was retired')
        count=0; digest=hashlib.sha256()
        for row in con.execute('SELECT entity_kind,entity_id,revision,source_revision,content_hash FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? ORDER BY entity_kind,entity_id',(ws,trace)):
            count+=1; digest.update(_json([str(item) for item in row]).encode('utf-8')+b'\n')
        return {'trace_id':trace,'incarnation':str(route['incarnation']),'route_epoch':str(route['route_epoch']),'heads_hash':digest.hexdigest(),'head_count':count,'scope_fingerprint':scope.fingerprint,'source':copy.deepcopy(source)}

    def prepare_for_save(self,token,ws,record):
        value=self._clean(record); identifier(value.get('id'))
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,'write'); self.iam._workspace(scope,ws,'read')
            found=con.execute('SELECT 1 FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,value['id'])).fetchone()
            head=self._get_tx(con,token,ws,value['id'],write=True) if found else None
        prior=self._load(head['manifest_hash'],head['manifest_ref']) if head else None
        sources={member['case_key']:member.get('trace_source') for member in prior['members']} if prior else {}
        proofs={}
        with self.control.read_transaction() as con:
            self.iam._workspace(self.iam._scope(con,token),ws,'write')
            if head and self._get_tx(con,token,ws,value['id'],write=True)!=head: raise Conflict('Dataset changed during preparation')
            for case in value.get('cases',[]):
                if not isinstance(case,dict): raise ValueError('Dataset Case object required')
                source=case.get('traceSource')
                if source is not None and (not isinstance(source,dict) or not any(source.get(key) for key in ('taskId','executionId'))): raise ValueError('Trace source identity required')
                if source is not None and sources.get(case.get('id'))!=source: proofs[case['id']]=self._source_proof(con,token,ws,source)
        incoming={case['id']:case.get('traceSource') for case in value.get('cases',[])}
        retained={key:copy.deepcopy(proof) for key,proof in (prior or {}).get('source_provenance',{}).items() if key in incoming and incoming[key]==sources.get(key)}
        retained.update(proofs)
        prepared=self._prepare_record(value,source_provenance=retained)
        prepared.update(prior_hash=head['manifest_hash'] if head else None,prior_sources=sources,source_proofs=proofs)
        return prepared

    def _get_tx(self,con,token,ws,identity,write=False,include_deleted=False,_capability=None):
        identifier(ws); identifier(identity)
        capability=_capability or ('write' if write else 'read')
        scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,capability)
        self.control.lock_keys(con, shared=(('dataset', ws, identity),))
        found=con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,identity)).fetchone()
        if found is None: raise DatasetNotFound('Dataset not found')
        head=dict(found); self.iam._authorize(con,token,ws,capability,'asset',head['asset_id'])
        if head['state']!='active' and not include_deleted: raise DatasetNotFound('Dataset is deleted')
        return head

    def _owner(self,con,ws,asset):
        row=con.execute("SELECT p.normalized_login_name FROM iam_resource_access a JOIN iam_principals p ON p.principal_id=a.owner_principal_id WHERE a.workspace_id=? AND a.resource_kind='asset' AND a.resource_id=?",(ws,asset)).fetchone()
        if row is None: raise Forbidden('Dataset owner unavailable')
        return row[0]

    @staticmethod
    def _etag(meta):
        return '"dataset:'+meta['asset_id']+':'+str(meta['revision'])+':'+str(meta['lifecycle_revision'])+(':release:'+meta['version_read'] if 'version_read' in meta else '')+'"'

    def _meta(self,head,owner):
        return {key:head[key] for key in ('workspace_id','dataset_id','asset_id','release_id','revision','lifecycle_revision','read_only','created_at_ms','updated_at_ms')}|{'owner':owner}

    def _envelope(self,root,meta,*,operation_result=None,include_trace=True,view='full',case_id=None):
        manifest=self._load(root['hash'],root['ref']); value=copy.deepcopy(manifest['metadata']); members=[]
        selected=[] if view=='summary' else [member for member in manifest['members'] if view!='case' or member['case_key']==case_id]
        if view=='case' and not selected: raise DatasetNotFound('Dataset Case not found')
        for member in selected:
            if view in {'items','reference'} or not include_trace:
                artifact=member['reference' if view=='reference' else 'items']; case=self._load(artifact['hash'],artifact['ref'],MAX_CASE_BYTES)
                if not include_trace:
                    case['trajectory']=''
                    for key in ('trace','trajectory'):
                        if key in case.get('values',{}): case['values'][key]=''
                members.append(case); continue
            case=self._load(member['public']['hash'],member['public']['ref'],MAX_CASE_BYTES)
            private=self._load(member['private']['hash'],member['private']['ref'],MAX_CASE_BYTES)
            private_values=private.pop('values',{})
            case.update(private)
            if private_values: case.setdefault('values',{}).update(private_values)
            if _hash(case)!=member['content_hash']: raise StorageError('Dataset Case content differs')
            if not include_trace:
                case['trajectory']=''
                if isinstance(case.get('values'),dict):
                    for key in ('trace','trajectory'):
                        if key in case['values']: case['values'][key]=''
            if view=='reference': case={key:case.get(key,[] if key=='tags' else '') for key in ('id','input','expectedOutput','evaluationFocus','tags')}
            members.append(case)
        value.update(user=meta['owner'],createdAt=_iso(meta['created_at_ms']),updatedAt=_iso(meta['updated_at_ms']))
        if view=='summary': value['caseCount']=len(manifest['members'])
        else: value['cases']=members
        if meta['read_only']: value['readOnly']=True
        result={'dataset':value,'revision':str(meta['revision']),'release_id':meta['release_id'],'lifecycle_revision':str(meta['lifecycle_revision']),'etag':self._etag(meta)}
        if operation_result is not None: result['operation_result']=copy.deepcopy(operation_result)
        _bounded(result,MAX_DATASET_BYTES+MAX_METADATA_BYTES); return result

    def _operation(self,kind,key,request):
        identifier(kind); identifier(key); _bounded(request,MAX_DATASET_BYTES)
        return _hash({'kind':kind,'request':request})

    def _receipt_tx(self,con,token,ws,kind,key,digest):
        capability='delete' if kind in {'delete','restore','generation-delete'} else 'write'
        scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,capability)
        row=con.execute('SELECT * FROM dataset_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind=? AND operation_key=?',(ws,scope.principal_id,kind,key)).fetchone()
        if row is None: return None
        if row['request_hash']!=digest: raise Conflict('Dataset operation key has different input')
        head=self._get_tx(con,token,ws,row['dataset_id'],include_deleted=capability=='delete',_capability=capability)
        meta=json.loads(row['response_meta_json'])
        if 'result' in meta and meta['result'].get('removed'): self.iam._workspace(scope,ws,'delete')
        else: self.iam._authorize(con,token,ws,'read','asset',head['asset_id'])
        if meta.get('state')=='deleted' and head['state']!='deleted': raise Conflict('Dataset deletion was superseded')
        if meta.get('state')!='deleted' and head['state']!='active': raise DatasetNotFound('Dataset was deleted')
        return {'root':{'hash':row['response_hash'],'ref':row['response_ref']},'meta':meta,'head':head}

    def lookup_operation(self,token,ws,operation_kind,operation_key,operation_request):
        digest=self._operation(operation_kind,operation_key,operation_request)
        with self.control.read_transaction() as con: found=self._receipt_tx(con,token,ws,operation_kind,operation_key,digest)
        if found is None: return None
        return self._receipt_result(token,ws,found)

    def record_operation(self,token,ws,identity,*,operation_key,operation_kind,operation_request,operation_result,expected_revision):
        digest=self._operation(operation_kind,operation_key,operation_request)
        with self.control.transaction(('dataset', ws, identity)) as con:
            self._lock_operation(con,token,ws,identity,operation_kind,operation_key)
            receipt=self._receipt_tx(con,token,ws,operation_kind,operation_key,digest)
            if receipt: root=receipt['root']; meta=receipt['meta']; head=receipt['head']
            else:
                head=self._get_tx(con,token,ws,identity,write=True)
                self.iam._authorize(con,token,ws,'read','asset',head['asset_id'])
                if head['read_only']: raise Forbidden('Dataset is read-only')
                if head['generation_source']=='trace' and head['generation_status']!='published': raise Conflict('Trace Dataset is not published')
                if _number(expected_revision)!=head['revision']: raise Conflict('Dataset changed concurrently')
                scope=self.iam._scope(con,token); root={'hash':head['manifest_hash'],'ref':head['manifest_ref']}
                meta=self._meta(head,self._owner(con,ws,head['asset_id'])); meta['operation_result']=copy.deepcopy(operation_result); _bounded(meta,MAX_METADATA_BYTES)
                self._write_receipt(con,scope,ws,operation_kind,operation_key,digest,head,root,meta)
        result=self._envelope(root,meta,operation_result=meta.get('operation_result')); self._verify(token,ws,head,write=True); return result

    def _receipt_result(self,token,ws,found):
        meta=found['meta']
        result=copy.deepcopy(meta['result']) if 'result' in meta else self._envelope(found['root'],meta,operation_result=meta.get('operation_result'))
        self._verify(token,ws,found['head'],include_deleted=meta.get('state')=='deleted',_capability='delete' if 'result' in meta and meta['result'].get('removed') else 'read')
        return result

    def _write_receipt(self,con,scope,ws,kind,key,digest,head,root,meta):
        con.execute('INSERT INTO dataset_operation_receipts(workspace_id,actor_principal_id,operation_kind,operation_key,request_hash,dataset_id,response_hash,response_ref,response_meta_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)',
                    (ws,scope.principal_id,kind,key,digest,head['dataset_id'],root['hash'],root['ref'],_json(meta),max(self.control.clock(),head['updated_at_ms'])))

    def _artifacts_tx(self,con,ws,artifacts):
        now=self.control.clock()
        for artifact in sorted(artifacts, key=lambda value: (value['namespace'], value['hash'])):
            identity=hashlib.sha256((artifact['namespace']+':'+artifact['hash']).encode()).hexdigest()
            con.execute("""INSERT INTO artifact_metadata(workspace_id,artifact_id,namespace,object_ref,content_hash,
                size_bytes,media_type,state,created_at_ms,published_at_ms)
                VALUES(?,?,?,?,?,?,?,'published',?,?)""" + self.control.insert_if_absent_clause,
                (ws,identity,artifact['namespace'],artifact['ref'],artifact['hash'],artifact['size'],'application/json',now,now))
            old=con.execute('SELECT content_hash,object_ref FROM artifact_metadata WHERE workspace_id=? AND artifact_id=?',(ws,identity)).fetchone()
            if old['content_hash']!=artifact['hash'] or old['object_ref']!=artifact['ref']:
                raise Conflict('Dataset artifact identity differs')

    def _lock_operation(self, con, token, ws, identity, kind, operation_key):
        actor = self.iam._scope(con, token)
        self.control.lock_keys(con, ('dataset', ws, identity),
                               ('dataset-receipt', ws, actor.principal_id, kind, operation_key))
        head = self.control.locked_row(con, 'SELECT asset_id FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (ws, identity))
        asset = head[0] if head else str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json(['dataset',ws,identity])))
        self.control.lock_keys(con, ('asset', ws, asset))

    def _save_tx(self,con,token,ws,prepared,*,operation_key,expected_revision=None,operation_kind='save',operation_result=None,operation_request=None,allow_generated=False,allow_readonly=False):
        value=prepared['record']; identity=value['id']; request=prepared['request'] if operation_request is None else operation_request
        self._lock_operation(con,token,ws,identity,operation_kind,operation_key)
        digest=self._operation(operation_kind,operation_key,request); old_receipt=self._receipt_tx(con,token,ws,operation_kind,operation_key,digest)
        if old_receipt:
            meta=old_receipt['meta']; return self._envelope(old_receipt['root'],meta,operation_result=meta.get('operation_result'))
        scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,'write'); self.iam._workspace(scope,ws,'read')
        exists=con.execute('SELECT 1 FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,identity)).fetchone()
        head=self._get_tx(con,token,ws,identity,write=True) if exists else None
        if head and head['read_only']: raise Forbidden('Dataset is read-only')
        if head and head['generation_source']=='trace' and head['generation_status']!='published' and not allow_generated: raise Conflict('Trace Dataset is not published')
        if (value.get('generationSource')=='trace' or value.get('generationStatus')) and not allow_generated:
            if not head or value.get('generationSource')!=head['generation_source'] or value.get('generationStatus')!=head['generation_status']: raise Forbidden('Generation state requires the fenced job protocol')
        if head is not None and prepared.get('prior_hash') is not None and prepared['prior_hash']!=head['manifest_hash']: raise Conflict('Dataset preparation is stale')
        prior_sources=prepared.get('prior_sources',{})
        for member in prepared['manifest']['members']:
            source=member.get('trace_source')
            if source is not None and prior_sources.get(member['case_key'])!=source:
                proof=prepared.get('source_proofs',{}).get(member['case_key'])
                if proof is None: raise ValueError('Trace sources require prepare_for_save')
                if self._source_proof(con,token,ws,source)!=proof: raise Conflict('Dataset Trace source changed before commit')
        if expected_revision is not None:
            if not (expected_revision in (0,'0') and head is None):
                expected=_number(expected_revision)
                if head is None or expected!=head['revision']: raise Conflict('Dataset changed concurrently')
        readonly=value['datasetKind']=='benchmark' or value['name']=='可靠性故障注入评测集（内置）' or (value['datasetKind']=='reliability' and any('内置' in tag for tag in value['tags']))
        if readonly and not allow_readonly and value['datasetKind']=='benchmark': raise Forbidden('Benchmark requires its provisioning protocol')
        now=max(self.control.clock(),head['updated_at_ms'] if head else 0); number=revision(head['revision']+1) if head else 1
        asset=head['asset_id'] if head else str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json(['dataset',ws,identity])))
        draft=head['draft_id'] if head else str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json(['dataset-draft',ws,identity])))
        release=str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json(['dataset-release',ws,asset,number,prepared['root']['hash']])))
        if head is None:
            con.execute('INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES(?,?,\'dataset\',?,?,?)',(ws,asset,'dataset:'+asset,now,now))
            self.iam._record_resource(con,ws,'asset',asset,scope.principal_id,'private',invalidate_policy=False)
        generation_source=value.get('generationSource') if allow_generated else head['generation_source'] if head else None
        generation_status=value.get('generationStatus') if allow_generated else head['generation_status'] if head else None
        small={'format':'dataset-manifest-ref/v1','hash':prepared['root']['hash'],'ref':prepared['root']['ref'],'case_count':len(value['cases'])}
        if head:
            self.control.lock_keys(con, ('asset-draft', ws, draft))
            prior_draft=con.execute('SELECT edit_revision FROM asset_drafts WHERE workspace_id=? AND draft_id=?',(ws,draft)).fetchone()[0]
            changed=con.execute('UPDATE asset_drafts SET manifest_json=?,edit_revision=?,updated_at_ms=? WHERE workspace_id=? AND draft_id=? AND edit_revision=?',(canonical_json(small),number,now,ws,draft,prior_draft))
            if changed.rowcount!=1: raise Conflict('Dataset draft changed concurrently')
        else: con.execute('INSERT INTO asset_drafts(workspace_id,draft_id,asset_id,branch_name,manifest_json,edit_revision,created_at_ms,updated_at_ms) VALUES(?,?,?,\'main\',?,1,?,?)',(ws,draft,asset,canonical_json(small),now,now))
        con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',(ws,release,asset,str(number),prepared['root']['hash'],prepared['root']['ref'],scope.principal_id,now))
        con.execute('INSERT INTO asset_release_seals(workspace_id,release_id,asset_id,dependency_count,created_at_ms) VALUES(?,?,?,0,?)',(ws,release,asset,now))
        if head:
            alias=con.execute("SELECT etag FROM asset_aliases WHERE workspace_id=? AND asset_id=? AND alias='latest'",(ws,asset)).fetchone()
            con.execute("UPDATE asset_aliases SET release_id=?,etag=?,updated_at_ms=? WHERE workspace_id=? AND asset_id=? AND alias='latest'",(release,revision(alias[0]+1),now,ws,asset))
            con.execute('UPDATE dataset_compat_heads SET release_id=?,manifest_hash=?,manifest_ref=?,revision=?,read_only=?,generation_source=?,generation_status=?,updated_at_ms=? WHERE workspace_id=? AND dataset_id=?',(release,prepared['root']['hash'],prepared['root']['ref'],number,int(readonly),generation_source,generation_status,now,ws,identity))
        else:
            con.execute("INSERT INTO asset_aliases(workspace_id,asset_id,alias,release_id,etag,created_at_ms,updated_at_ms) VALUES(?,?,'latest',?,1,?,?)",(ws,asset,release,now,now))
            con.execute('INSERT INTO dataset_compat_heads(workspace_id,dataset_id,asset_id,draft_id,release_id,manifest_hash,manifest_ref,read_only,generation_source,generation_status,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(ws,identity,asset,draft,release,prepared['root']['hash'],prepared['root']['ref'],int(readonly),generation_source,generation_status,scope.principal_id,now,now))
        self._artifacts_tx(con,ws,prepared['artifacts'])
        head=dict(con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,identity)).fetchone()); meta=self._meta(head,self._owner(con,ws,asset))
        if operation_result is not None: meta['operation_result']=copy.deepcopy(operation_result)
        _bounded(meta,MAX_METADATA_BYTES)
        self._write_receipt(con,scope,ws,operation_kind,operation_key,digest,head,prepared['root'],meta)
        self._queue_projection_tx(con,ws,asset,release,prepared['root']['hash'],prepared['root']['ref'],head['lifecycle_revision'],now)
        # Prepared bodies are already in memory; no payload reads are needed by a caller's job transaction.
        dto=copy.deepcopy(value); dto.update(user=meta['owner'],createdAt=_iso(head['created_at_ms']),updatedAt=_iso(now))
        if readonly: dto['readOnly']=True
        result={'dataset':dto,'revision':str(number),'release_id':release,'lifecycle_revision':str(head['lifecycle_revision']),'etag':self._etag(meta)}
        if operation_result is not None: result['operation_result']=copy.deepcopy(operation_result)
        return result

    def save(self,token,ws,record,*,operation_key,expected_revision=None,operation_kind='save',operation_result=None,operation_request=None):
        request=self._clean(record) if operation_request is None else operation_request
        found=self.lookup_operation(token,ws,operation_kind,operation_key,request)
        if found is not None: return found
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,'write'); self.iam._workspace(scope,ws,'read')
            observed=0
            if isinstance(record,dict) and con.execute('SELECT 1 FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,record.get('id'))).fetchone():
                head=self._get_tx(con,token,ws,record['id'],write=True)
                if head['read_only']: raise Forbidden('Dataset is read-only')
                if head['generation_source']=='trace' and head['generation_status']!='published': raise Conflict('Trace Dataset is not published')
                observed=head['revision']
        prepared=self.prepare_for_save(token,ws,record)
        with self.control.transaction(('dataset', ws, record['id']), shared=[('trace', ws, proof['trace_id']) for proof in prepared['source_proofs'].values()]) as con:
            result=self._save_tx(con,token,ws,prepared,operation_key=operation_key,expected_revision=expected_revision if expected_revision is not None else observed,operation_kind=operation_kind,operation_result=operation_result,operation_request=operation_request)
            head=self._get_tx(con,token,ws,record['id'],write=True)
        self._verify(token,ws,head,write=True); return result

    def _verify(self,token,ws,head,*,include_deleted=False,write=False,_capability=None):
        with self.control.read_transaction() as con:
            current=self._get_tx(con,token,ws,head['dataset_id'],write=write,include_deleted=include_deleted,_capability=_capability)
            if write: self.iam._authorize(con,token,ws,'read','asset',head['asset_id'])
            if current!=head: raise Conflict('Dataset changed while reading')

    def get(self,token,ws,identity,version=None,*,_view='full',_include_trace=True,_case_id=None):
        if _view not in {'full','summary','reference','items','case'}: raise ValueError('Invalid Dataset view')
        if _view=='case': identifier(_case_id)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token); head=self._get_tx(con,token,ws,identity)
            meta=self._meta(head,self._owner(con,ws,head['asset_id'])); root={'hash':head['manifest_hash'],'ref':head['manifest_ref']}
            if version is not None:
                release=con.execute('SELECT r.* FROM asset_releases r JOIN asset_release_seals s ON s.workspace_id=r.workspace_id AND s.release_id=r.release_id WHERE r.workspace_id=? AND r.asset_id=? AND (r.release_id=? OR r.version_label=?)',(ws,head['asset_id'],str(version),str(version))).fetchone()
                if release is None: raise DatasetNotFound('Dataset version not found')
                root={'hash':release['content_hash'],'ref':release['manifest_ref']}; meta.update(release_id=release['release_id'],revision=int(release['version_label']),updated_at_ms=release['created_at_ms'],version_read=release['release_id'])
        try:
            result=self._envelope(root,meta,view=_view,include_trace=_include_trace,case_id=_case_id)
            if version is None and _view!='summary': self._merge_cache(token,ws,head,result['dataset'])
        finally:
            self._verify(token,ws,head)
            if self.iam.scope(token).fingerprint!=scope.fingerprint: raise Forbidden('Dataset authorization changed while reading')
        return result

    def list(self,token,ws,view='full',target_skill=None,include_trace=True,include_metadata=False):
        if view not in {'full','summary','reference','items'}: raise ValueError('Invalid Dataset view')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token); grant=self.iam._workspace(scope,ws,'read')
            access=''; parameters=[ws]
            if grant.role not in {'owner','admin','personal'}:
                access=" AND (a.owner_principal_id=? OR a.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=a.workspace_id AND g.resource_kind='asset' AND g.resource_id=a.resource_id AND g.grantee_principal_id=?))"
                parameters.extend([scope.principal_id,scope.principal_id])
            parameters.append(MAX_DATASETS+1)
            rows=con.execute("SELECT h.dataset_id FROM dataset_compat_heads h JOIN iam_resource_access a ON a.workspace_id=h.workspace_id AND a.resource_kind='asset' AND a.resource_id=h.asset_id WHERE h.workspace_id=? AND h.state='active'"+access+' ORDER BY h.updated_at_ms DESC,h.dataset_id LIMIT ?',tuple(parameters)).fetchall()
        if len(rows)>MAX_DATASETS: raise DatasetTooLarge('Dataset list exceeds bounded item count')
        results=[]; total_bytes=2
        for row in rows:
            try: envelope=self.get(token,ws,row[0],_view=view,_include_trace=include_trace)
            except Forbidden: continue
            value=envelope['dataset']
            if target_skill is not None and value.get('targetSkill')!=target_skill: continue
            if include_metadata: value['_storageEtag']=envelope['etag']
            total_bytes+=_bounded(value,MAX_DATASET_BYTES)+(1 if results else 0)
            if total_bytes>MAX_DATASET_BYTES: raise DatasetTooLarge('Dataset list exceeds cumulative byte budget')
            results.append(value)
        if self.iam.scope(token).fingerprint!=scope.fingerprint: raise Forbidden('Dataset authorization changed while listing')
        return results

    @staticmethod
    def _cache_id(identity,case,output):
        return 'dataset-cache:'+_hash(identity)+':'+_hash([case,output])

    def _merge_cache(self,token,ws,head,dataset):
        with self.control.read_transaction() as con:
            self._get_tx(con,token,ws,head['dataset_id'])
            rows=con.execute("SELECT artifact_id,content_hash,object_ref FROM artifact_metadata WHERE workspace_id=? AND namespace='dataset.cache' AND state='published' AND artifact_id LIKE ?",(ws,'dataset-cache:'+_hash(head['dataset_id'])+':%')).fetchall()
        lookup={row['artifact_id']:row for row in rows}
        for case in dataset.get('cases',[]):
            key=self._cache_id(head['dataset_id'],case['id'],case.get('expectedOutput','')); row=lookup.get(key)
            if row is None: continue
            value=self._load(row['content_hash'],row['object_ref'],MAX_METADATA_BYTES)
            if value.get('dataset_id')!=head['dataset_id'] or value.get('case_id')!=case['id'] or value.get('output_hash')!=_hash(case.get('expectedOutput','')): raise StorageError('Dataset cache binding differs')
            case['rootCauses']=value['root_causes']
            if value.get('root_cause_meta') is not None: case['rootCauseMeta']=value['root_cause_meta']

    def cache_root_causes(self,token,ws,identity,case_id,expected_output,root_causes,expected_revision,root_cause_meta=None):
        expected=_number(expected_revision)
        if not isinstance(expected_output,str) or not isinstance(root_causes,list): raise ValueError('Invalid Dataset cache')
        with self.control.read_transaction() as con:
            head=self._get_tx(con,token,ws,identity,write=True)
            if head['read_only']: raise Forbidden('Dataset is read-only')
            if head['revision']!=expected: return False
        current=self.get(token,ws,identity)
        case=next((row for row in current['dataset']['cases'] if row['id']==case_id),None)
        if case is None or case.get('expectedOutput','')!=expected_output: return False
        value={'dataset_id':identity,'case_id':case_id,'output_hash':_hash(expected_output),'root_causes':root_causes,'root_cause_meta':root_cause_meta}
        _bounded(value,MAX_METADATA_BYTES); artifact=self._store(value,'dataset.cache'); cache=self._cache_id(identity,case_id,expected_output)
        with self.control.transaction(('dataset', ws, identity)) as con:
            latest=self._get_tx(con,token,ws,identity,write=True)
            if latest!=head: return False
            row=con.execute('SELECT 1 FROM artifact_metadata WHERE workspace_id=? AND artifact_id=?',(ws,cache)).fetchone(); now=self.control.clock()
            if row: con.execute('UPDATE artifact_metadata SET object_ref=?,content_hash=?,size_bytes=? WHERE workspace_id=? AND artifact_id=?',(artifact['ref'],artifact['hash'],artifact['size'],ws,cache))
            else: con.execute("INSERT INTO artifact_metadata(workspace_id,artifact_id,namespace,object_ref,content_hash,size_bytes,media_type,state,created_at_ms,published_at_ms) VALUES(?,?,'dataset.cache',?,?,?,'application/json','published',?,?)",(ws,cache,artifact['ref'],artifact['hash'],artifact['size'],now,now))
        self._verify(token,ws,head,write=True); return True

    def versions(self,token,ws,identity,view='full'):
        if view not in {'full','summary'}: raise ValueError('Invalid Dataset version view')
        with self.control.read_transaction() as con:
            head=self._get_tx(con,token,ws,identity)
            releases=con.execute('SELECT release_id FROM asset_releases WHERE workspace_id=? AND asset_id=? ORDER BY created_at_ms DESC,release_id LIMIT ?',(ws,head['asset_id'],MAX_VERSIONS+1)).fetchall()
        if len(releases)>MAX_VERSIONS: raise DatasetTooLarge('Dataset version history exceeds bounded response')
        result=[]; total_bytes=2
        for row in releases:
            item=self.get(token,ws,identity,version=row[0],_view=view)
            total_bytes+=_bounded(item,MAX_DATASET_BYTES)+(1 if result else 0)
            if total_bytes>MAX_DATASET_BYTES: raise DatasetTooLarge('Dataset versions exceed cumulative byte budget')
            result.append(item)
        self._verify(token,ws,head); return result

    def _delete_tx(self,con,token,ws,identity,*,operation_key,expected_revision=None,operation_kind='delete',operation_request=None):
        self._lock_operation(con,token,ws,identity,operation_kind,operation_key)
        request={'dataset_id':identity,'expected_revision':str(expected_revision) if expected_revision is not None else None} if operation_request is None else operation_request
        digest=self._operation(operation_kind,operation_key,request); receipt=self._receipt_tx(con,token,ws,operation_kind,operation_key,digest)
        if receipt: return copy.deepcopy(receipt['meta']['result'])
        scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,'delete'); head=self._get_tx(con,token,ws,identity,_capability='delete')
        if head['read_only']: raise Forbidden('Dataset is read-only')
        if expected_revision is not None and _number(expected_revision)!=head['revision']: raise Conflict('Dataset changed concurrently')
        now=max(self.control.clock(),head['updated_at_ms']); number=revision(head['revision']+1); lifecycle=revision(head['lifecycle_revision']+1)
        con.execute("UPDATE dataset_compat_heads SET state='deleted',revision=?,lifecycle_revision=?,deleted_by=?,deleted_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND dataset_id=?",(number,lifecycle,scope.principal_id,now,now,ws,identity))
        self.iam._touch_policy(con,ws)
        result={'removed':True,'dataset_id':identity,'revision':str(number),'lifecycle_revision':str(lifecycle)}
        self._write_receipt(con,scope,ws,operation_kind,operation_key,digest,head,{'hash':head['manifest_hash'],'ref':head['manifest_ref']},{'state':'deleted','result':result})
        return result

    def remove(self,token,ws,identity,*,operation_key,expected_revision=None,operation_kind='delete',operation_request=None):
        with self.control.transaction(('dataset', ws, identity)) as con: result=self._delete_tx(con,token,ws,identity,operation_key=operation_key,expected_revision=expected_revision,operation_kind=operation_kind,operation_request=operation_request)
        return result

    def restore(self,token,ws,identity,*,operation_key,expected_revision=None,operation_request=None):
        request={'dataset_id':identity,'expected_revision':str(expected_revision) if expected_revision is not None else None} if operation_request is None else operation_request
        digest=self._operation('restore',operation_key,request)
        with self.control.transaction(('dataset', ws, identity)) as con:
            self._lock_operation(con,token,ws,identity,'restore',operation_key)
            receipt=self._receipt_tx(con,token,ws,'restore',operation_key,digest)
            if receipt: root=receipt['root']; meta=receipt['meta']; head=receipt['head']
            else:
                scope=self.iam._scope(con,token); self.iam._workspace(scope,ws,'delete'); self.iam._workspace(scope,ws,'read'); head=self._get_tx(con,token,ws,identity,include_deleted=True,_capability='delete')
                if head['state']!='deleted': raise Conflict('Dataset is not deleted')
                if head['read_only']: raise Forbidden('Dataset is read-only')
                if expected_revision is not None and _number(expected_revision)!=head['revision']: raise Conflict('Dataset changed concurrently')
                now=max(self.control.clock(),head['updated_at_ms'])
                con.execute("UPDATE dataset_compat_heads SET state='active',revision=?,lifecycle_revision=?,deleted_by=NULL,deleted_at_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND dataset_id=?",(revision(head['revision']+1),revision(head['lifecycle_revision']+1),now,ws,identity))
                self.iam._touch_policy(con,ws); head=self._get_tx(con,token,ws,identity,_capability='delete'); meta=self._meta(head,self._owner(con,ws,head['asset_id']))
                root={'hash':head['manifest_hash'],'ref':head['manifest_ref']}; self._write_receipt(con,scope,ws,'restore',operation_key,digest,head,root,meta)
                releases=con.execute('SELECT release_id,content_hash,manifest_ref FROM asset_releases WHERE workspace_id=? AND asset_id=? ORDER BY created_at_ms,release_id',(ws,head['asset_id'])).fetchall()
                for release in releases: self._queue_projection_tx(con,ws,head['asset_id'],release['release_id'],release['content_hash'],release['manifest_ref'],head['lifecycle_revision'],now)
        result=self._envelope(root,meta); self._verify(token,ws,head); return result

    def projection_status(self,token,ws,identity,version=None):
        with self.control.read_transaction() as con:
            head=self._get_tx(con,token,ws,identity)
            release=con.execute('SELECT release_id FROM asset_releases WHERE workspace_id=? AND asset_id=? AND (release_id=? OR version_label=?)',(ws,head['asset_id'],str(version or head['release_id']),str(version or head['release_id']))).fetchone()
            if release is None: raise DatasetNotFound('Dataset version not found')
            rows=con.execute("SELECT payload_json,state FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='dataset.release.published.v1'",(ws,head['asset_id'])).fetchall()
            row=next((row for row in rows if json.loads(row['payload_json'])['release_id']==release[0] and str(json.loads(row['payload_json'])['lifecycle_revision'])==str(head['lifecycle_revision'])),None)
        state='indexed' if row and row['state']=='sent' else 'failed' if row and row['state']=='dead' else 'pending'
        self._verify(token,ws,head); return {'release_id':release[0],'state':state}

    def _queue_projection_tx(self,con,ws,asset,release,digest,ref,lifecycle,now):
        previous=con.execute("SELECT MAX(aggregate_revision),MAX(created_at_ms) FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='dataset.release.published.v1'",(ws,asset)).fetchone()
        sequence=revision((previous[0] or 0)+1); queued=max(now,previous[1]+1 if previous[1] is not None else now)
        con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)',(ws,str(uuid.uuid4()),asset,sequence,'dataset.release.published.v1',canonical_json({'release_id':release,'manifest_hash':digest,'manifest_ref':ref,'lifecycle_revision':lifecycle}),queued,now))

    def _projection_owned(self,con,event,lease_ms=None):
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(event['workspace_id'],event['event_id'])).fetchone()
        if row is None or row['state']!='dispatching' or row['attempts']!=event['attempts'] or row['lease_owner']!=event['lease_owner'] or row['lease_until_ms']<=self.control.clock(): raise Conflict('Dataset projection lease lost')
        payload=json.loads(row['payload_json']); head=con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND asset_id=?',(event['workspace_id'],event['aggregate_id'])).fetchone()
        if head is None or head['state']!='active': raise DatasetNotFound('Dataset projection route retired')
        if str(head['lifecycle_revision'])!=str(payload['lifecycle_revision']): raise DatasetNotFound('Dataset projection lifecycle was retired')
        release=con.execute('SELECT * FROM asset_releases WHERE workspace_id=? AND asset_id=? AND release_id=?',(event['workspace_id'],event['aggregate_id'],payload['release_id'])).fetchone()
        if release is None or release['content_hash']!=payload['manifest_hash'] or release['manifest_ref']!=payload['manifest_ref']: raise StorageError('Dataset projection source differs')
        if lease_ms is not None:
            now=max(self.control.clock(),row['updated_at_ms'])
            con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',(now+lease_ms,now,event['workspace_id'],event['event_id']))
        return dict(release)

    def project_once(self,facts,worker_id,lease_ms=30000):
        identifier(worker_id)
        if type(lease_ms) is not int or not 1<=lease_ms<=3600000: raise ValueError('Invalid projection lease')
        with self.control.transaction(('dataset-projection',)) as con:
            now=self.control.clock()
            row=con.execute("SELECT * FROM outbox_events WHERE event_type='dataset.release.published.v1' AND state IN ('pending','dispatching') ORDER BY created_at_ms,event_id LIMIT 1").fetchone()
            if row is None or row['next_attempt_at_ms']>now or row['state']=='dispatching' and row['lease_until_ms']>now: return False
            event=dict(row); event.update(attempts=revision(row['attempts']+1),lease_owner=worker_id)
            con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(event['attempts'],worker_id,now+lease_ms,max(now,row['updated_at_ms']),row['workspace_id'],row['event_id']))
        def projection_transaction():
            return self.control.transaction(('dataset-projection', event['workspace_id'], event['event_id']),
                                            shared=(('asset', event['workspace_id'], event['aggregate_id']),))

        try:
            with projection_transaction() as con: release=self._projection_owned(con,event,lease_ms)
            manifest=self._load(release['content_hash'],release['manifest_ref'])
            bucket=_iso(release['created_at_ms'])[:10]; fields_hash=_hash(manifest['metadata'].get('fields',[])); samples=[]; members=[]
            for member in manifest['members']:
                public=self._load(member['public']['hash'],member['public']['ref'],MAX_CASE_BYTES); gold=self._load(member['private']['hash'],member['private']['ref'],MAX_CASE_BYTES)
                private_values=gold.pop('values',{}); public.update(gold)
                if private_values: public.setdefault('values',{}).update(private_values)
                if _hash(public)!=member['content_hash']: raise StorageError('Dataset projection Case differs')
                sample=_hash([event['aggregate_id'],release['release_id'],member['case_key'],member['content_hash']])
                samples.append({'workspace_id':event['workspace_id'],'sample_bucket':bucket,'dataset_id':event['aggregate_id'],'sample_revision_id':sample,'case_key':member['case_key'],
                    'public_payload_ref':'dataset.public:'+member['public']['hash'],'private_payload_ref':'dataset.gold:'+member['private']['hash'],'field_schema_release_id':release['release_id'],'content_hash':member['content_hash'],'source_snapshot_id':'','attributes_json':_json({'field_schema_hash':fields_hash}),'retry_version':1})
                members.append({'workspace_id':event['workspace_id'],'release_bucket':bucket,'dataset_release_id':release['release_id'],'ordinal':member['ordinal'],'case_key':member['case_key'],'sample_revision_id':sample,'sample_bucket':bucket,'content_hash':member['content_hash'],'retry_version':1})
            for table,rows in [('dataset_sample_revisions',samples),('dataset_release_members',members)]:
                for offset in range(0,len(rows),128):
                    with projection_transaction() as con: self._projection_owned(con,event,lease_ms)
                    facts._insert(table,rows[offset:offset+128])
            with projection_transaction() as con:
                self._projection_owned(con,event)
                con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(max(self.control.clock(),event['updated_at_ms']),event['workspace_id'],event['event_id']))
        except Exception as cause:
            with projection_transaction() as con:
                row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(event['workspace_id'],event['event_id'])).fetchone()
                if row and row['state']=='dispatching' and row['lease_owner']==worker_id and row['attempts']==event['attempts']:
                    dead=isinstance(cause,(DatasetNotFound,StorageError,ValueError)) and not isinstance(cause,Conflict)
                    now=max(self.control.clock(),row['updated_at_ms'])
                    con.execute('UPDATE outbox_events SET state=?,lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',('dead' if dead else 'pending',now+min(60000,1000*(2**min(event['attempts'],6))),now,event['workspace_id'],event['event_id']))
        return True
