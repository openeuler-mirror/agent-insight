import datetime
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .contracts import identifier, revision, canonical_json, content_hash


class ClickHouseError(Exception):
    pass


class ClickHouseResponseTooLarge(ClickHouseError):
    status=413


class IncompletePayload(ClickHouseError):
    pass


CATALOG = json.loads((Path(__file__).parent / 'schema' / 'clickhouse-catalog.json').read_text())
TABLES = {table['name']: table for table in CATALOG['tables']}


class ClickHouseStore:
    def __init__(self, endpoint, *, database, user='default', password='', timeout=30):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'','/'}:
            raise ValueError('use an HTTP(S) origin without URL credentials or query parameters')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', database):
            raise ValueError('invalid database identifier')
        if not isinstance(timeout, (int,float)) or not 0 < timeout <= 300:
            raise ValueError('invalid request timeout')
        self.endpoint = endpoint.rstrip('/')
        self.database = database
        self.user = user
        self.password = password
        self.timeout = timeout

    def _request(self, sql, *, parameters=None, rows=None, database=None):
        options = {'database': database or self.database, 'wait_end_of_query': '1', 'output_format_json_quote_64bit_integers': '1'}
        options.update({f'param_{key}': str(value) for key,value in (parameters or {}).items()})
        body = sql.encode('utf-8')
        if rows is not None:
            body += b'\n' + b'\n'.join(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8') for row in rows)
        if len(body) > 4*1024*1024:
            raise ValueError('encoded request exceeds 4MiB; split the batch')
        request = urllib.request.Request(self.endpoint+'/?'+urllib.parse.urlencode(options), data=body,
            headers={'X-ClickHouse-User':self.user,'X-ClickHouse-Key':self.password,'Content-Type':'text/plain; charset=utf-8'},method='POST')
        # Do not forward database credentials to an HTTP redirect target.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=self.timeout) as response:
                result = response.read(16*1024*1024 + 1)
                if len(result) > 16*1024*1024:
                    raise ClickHouseError('response exceeds bounded adapter size; paginate')
                return result
        except (urllib.error.URLError, OSError) as exc:
            raise ClickHouseError('ClickHouse request failed; inspect server logs without exposing credentials') from exc

    def check_schema(self):
        expected = {}
        for path in sorted((Path(__file__).parent / 'schema' / 'clickhouse').glob('*.sql')):
            for name, body in re.findall(r'CREATE TABLE (\w+)\s*\((.*?)\)\s*ENGINE', path.read_text(), re.S):
                expected[name] = {column for column, _ in re.findall(r'(?:^|,)\s*(\w+)\s+(\w+)', body) if column != 'CONSTRAINT'}
        rows = self._request('SELECT table, name FROM system.columns WHERE database = {db:String} FORMAT JSONEachRow', parameters={'db': self.database})
        actual = {}
        for line in rows.splitlines():
            row = json.loads(line)
            actual.setdefault(row['table'], set()).add(row['name'])
        if not expected or any(not columns <= actual.get(name, set()) for name, columns in expected.items()):
            raise ClickHouseError('ClickHouse schema is incomplete; explicitly initialize or upgrade the analytical database')
        # Query the actual tables as well: visibility in system.columns does not grant SELECT.
        self._request(' UNION ALL '.join(f'SELECT 1 FROM {name} LIMIT 0' for name in expected))
        return {'schema_version': 4, 'tables': len(expected)}

    def initialize_new_database(self):
        self._request(f'CREATE DATABASE {self.database}', database='default')
        sql = (Path(__file__).parent / 'schema' / 'clickhouse' / '001_core.sql').read_text()
        for statement in sql.split(';'):
            if statement.strip():
                self._request(statement)

    def initialize_analytics_schema(self):
        sql=(Path(__file__).parent/'schema'/'clickhouse'/'002_trace_analytics.sql').read_text()
        for statement in sql.split(';'):
            if statement.strip():self._request(statement)

    def initialize_semantic_usage_schema(self):
        sql=(Path(__file__).parent/'schema'/'clickhouse'/'004_semantic_usage.sql').read_text()
        for statement in sql.split(';'):
            if statement.strip():self._request(statement)

    def write_semantic_fact(self,table,row):
        if table not in {'semantic_immutable_facts','usage_event_facts','usage_daily_facts'}:raise ValueError('Known semantic fact table required')
        if set(row)!={'workspace_id','owner_principal_id','kind','record_id','content_hash','body_json','retry_version'}:raise ValueError('Fixed semantic fact required')
        for field in ('workspace_id','owner_principal_id','kind','record_id'):identifier(row[field])
        if not re.fullmatch(r'[a-f0-9]{64}',row['content_hash']):raise ValueError('Semantic digest required')
        self._write_analytics_fact(table,row)

    def delete_usage_event_facts(self,workspace,owner,ids):
        identifier(workspace);identifier(owner)
        if not isinstance(ids,list) or not 1<=len(ids)<=50000:raise ValueError('Bounded usage cleanup required')
        parameters={'workspace':workspace,'owner':owner}
        names=[]
        for i,value in enumerate(ids):parameters['event'+str(i)]=identifier(value);names.append('{event'+str(i)+':String}')
        self._request('ALTER TABLE usage_event_facts DELETE WHERE workspace_id={workspace:String} AND owner_principal_id={owner:String} AND record_id IN ('+','.join(names)+') SETTINGS mutations_sync=1',parameters=parameters)

    def read_semantic_fact(self,table,workspace,owner,kind,record,content):
        if table not in {'semantic_immutable_facts','usage_event_facts','usage_daily_facts'}:raise ValueError('Known semantic fact table required')
        sql='SELECT body_json FROM '+table+' FINAL WHERE workspace_id={workspace:String} AND owner_principal_id={owner:String} AND kind={kind:String} AND record_id={record:String} AND content_hash={content:String} LIMIT 2 FORMAT JSONEachRow'
        raw=self._request(sql,parameters={'workspace':workspace,'owner':owner,'kind':kind,'record':record,'content':content})
        rows=[json.loads(line) for line in raw.decode().splitlines() if line]
        if len(rows)!=1:return None
        return json.loads(rows[0]['body_json'])

    def initialize_infra_schema(self):
        sql=(Path(__file__).parent/'schema'/'clickhouse'/'003_infra.sql').read_text()
        for statement in sql.split(';'):
            if statement.strip():self._request(statement)

    def write_infra_sample(self,row):
        required={'workspace_id','source_id','sample_id','owner_principal_id','content_hash','ts_ms','received_at_ms','sample_json','retry_version'}
        if set(row)!=required:raise ValueError('Unknown Infra sample fields')
        for key in ('workspace_id','source_id','sample_id','owner_principal_id'):identifier(row[key])
        self._write_analytics_fact('infra_metric_samples',row)

    def read_infra_samples(self,workspace,source,*,limit=512,order='asc',model=None,via=None,from_ms=None,to_ms=None,after=None):
        identifier(workspace);identifier(source)
        if type(limit) is not int or not 1<=limit<=5000 or order not in ('asc','desc'):raise ValueError('Invalid Infra sample query')
        parameters={'workspace':workspace,'source':source};clauses=['workspace_id={workspace:String}','source_id={source:String}']
        for key,operator,stamp in [('from','>=',from_ms),('to','<=',to_ms)]:
            if stamp is not None:parameters[key]=stamp;clauses.append('ts_ms'+operator+'{'+key+':Float64}')
        for key,value in [('model',model),('via',via)]:
            if value:parameters[key]=value;clauses.append("JSONExtractString(sample_json,'"+key+"')={"+key+':String}')
        if after:
            parameters.update(after_ts=after['ts_ms'],after_id=after['sample_id']);operator='>' if order=='asc' else '<';clauses.append('(ts_ms,sample_id)'+operator+'({after_ts:Float64},{after_id:String})')
        count=limit
        while True:
            sql='SELECT * FROM infra_metric_samples FINAL WHERE '+' AND '.join(clauses)+' ORDER BY ts_ms '+order+',sample_id '+order+' LIMIT '+str(count)+' FORMAT JSONEachRow'
            try:return [json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]
            except ClickHouseError as exc:
                if count==1 or str(exc)!='response exceeds bounded adapter size; paginate':raise
                count=max(1,count//2)

    def write_analytics(self,row):
        self._scope(row['workspace_id'],row['trace_bucket'],row['trace_id'])
        if set(row)!={'workspace_id','trace_bucket','trace_id','boundary','parser_version','projection_hash','projection_json','retry_version'}:raise ValueError('Unknown analytics fact fields')
        self._write_analytics_fact('obs_trace_analytics',row)

    def _write_analytics_fact(self,table,row):
        sql='INSERT INTO '+table+' FORMAT JSONEachRow'
        wire=len(sql.encode('utf-8'))+1+len(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))
        if wire>4*1024*1024:raise ClickHouseResponseTooLarge('Encoded analytics fact exceeds 4MiB transport budget')
        self._request(sql,rows=[row])

    def _analytics_fact_query(self,table,workspace,items,columns,select):
        parameters={'workspace_id':workspace};clauses=[]
        for i,row in enumerate(items):
            parts=[]
            for key in columns:
                parameters[f'{key}_{i}']=row[key]
                parts.append(key+'={'+key+'_'+str(i)+':'+('Date' if key.endswith('_bucket') else 'String')+'}')
            clauses.append('('+' AND '.join(parts)+')')
        sql='SELECT '+select+' FROM '+table+' FINAL WHERE workspace_id={workspace_id:String}'+(' AND parser_version=1' if table=='obs_trace_analytics' else '')+' AND ('+' OR '.join(clauses)+') FORMAT JSONEachRow'
        return [json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]

    def _read_analytics_facts(self,table,workspace,selections,columns,body_column,maximum):
        if not selections:return []
        wanted={tuple(row[key] for key in columns):row for row in selections};sized=[];total=0;seen=set()
        for offset in range(0,len(selections),200):
            metadata=self._analytics_fact_query(table,workspace,selections[offset:offset+200],columns,','.join(columns)+',length('+body_column+') AS analytics_bytes')
            for row in metadata:
                identity=tuple(row.get(key) for key in columns)
                if identity not in wanted or identity in seen:raise ClickHouseError('Analytics size vector differs from selected facts')
                try:size=int(row['analytics_bytes'])
                except (ValueError,TypeError,KeyError):raise ClickHouseError('Invalid analytics size metadata') from None
                if not 0<=size<=maximum:raise ClickHouseResponseTooLarge('Analytics fact exceeds its individual byte budget')
                total+=size
                if total>8*1024*1024:raise ClickHouseResponseTooLarge('Analytics page exceeds 8MiB; request fewer traces')
                seen.add(identity);sized.append((wanted[identity],size))
        batches=[];batch=[];size=0
        for row,length in sized:
            if batch and (size+length>2*1024*1024 or len(batch)>=200):batches.append(batch);batch=[];size=0
            batch.append(row);size+=length
        if batch:batches.append(batch)
        result=[]
        for batch in batches:result.extend(self._analytics_fact_query(table,workspace,batch,columns,'*'))
        return result

    def read_analytics(self,workspace_id,selections):
        identifier(workspace_id)
        if not isinstance(selections,list) or len(selections)>200:raise ValueError('Analytics fact selection must contain at most 200 traces')
        for row in selections:
            self._scope(workspace_id,row['trace_bucket'],row['trace_id'])
        return self._read_analytics_facts('obs_trace_analytics',workspace_id,selections,('trace_id','trace_bucket','boundary','projection_hash'),'projection_json',2*1024*1024)

    def write_ras_event(self,row):
        identifier(row['workspace_id']);identifier(row['owner_principal_id']);identifier(row['task_id']);identifier(row['event_key'])
        datetime.date.fromisoformat(row['event_bucket'])
        if set(row)!={'workspace_id','event_bucket','owner_principal_id','task_id','event_key','event_id','content_hash','event_json','retry_version'}:raise ValueError('Unknown RAS fact fields')
        self._write_analytics_fact('obs_ras_events',row)

    def read_ras_events(self,workspace_id,selections):
        identifier(workspace_id)
        if not isinstance(selections,list) or len(selections)>10000:raise ValueError('RAS event selection exceeds 10000')
        dated=[dict(row,event_bucket=datetime.datetime.fromtimestamp(row['occurred_at_ms']/1000,datetime.timezone.utc).date().isoformat()) for row in selections]
        return self._read_analytics_facts('obs_ras_events',workspace_id,dated,('event_bucket','owner_principal_id','task_id','event_key','content_hash'),'event_json',262144)

    def _scope(self, workspace_id, bucket, trace_id, span_id=None):
        datetime.date.fromisoformat(bucket)
        result = {'workspace_id':identifier(workspace_id),'trace_bucket':bucket,'trace_id':identifier(trace_id)}
        if span_id is not None: result['span_id'] = identifier(span_id)
        return result

    def _insert(self, table, rows):
        if table not in TABLES: raise ValueError('unknown facts table')
        if not rows: return
        if len(rows)>4096: raise ValueError('batch row count exceeds 4096')
        batch=[]
        size=128
        for row in rows:
            encoded_size=len(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))+1
            if encoded_size+128 > 4*1024*1024:
                raise ValueError('single encoded fact exceeds bounded request size')
            if size+encoded_size>4*1024*1024:
                self._request(f'INSERT INTO {table} FORMAT JSONEachRow',rows=batch)
                batch=[];size=128
            batch.append(row);size+=encoded_size
        if batch: self._request(f'INSERT INTO {table} FORMAT JSONEachRow',rows=batch)

    def write_spans(self, rows):
        if not isinstance(rows,list) or len(rows)>4096: raise ValueError('invalid bounded span batch')
        columns={column['name'] for column in TABLES['obs_span_current']['columns']}
        for row in rows:
            if not isinstance(row,dict) or set(row)-columns: raise ValueError('unknown Span columns')
            self._scope(row['workspace_id'],row['trace_bucket'],row['trace_id'],row['span_id'])
            revision(row['revision'])
        self._insert('obs_span_current',rows)

    def read_trace_page(self,workspace,ids,count,offset,direction,ownership):
        if direction not in ('asc','desc') or not 1<=count<=101 or offset<0:raise ValueError('invalid Trace page')
        query="""SELECT trace_id FROM obs_trace_current FINAL WHERE workspace_id={workspace:String} AND is_deleted=0
            AND has({ids:Array(String)},trace_id) AND NOT JSONExtractBool(attributes_json,'is_subagent')"""
        escaped=["'"+identifier(value).replace('\\','\\\\').replace("'","\\'")+"'" for value in ids]
        query=query.replace('has({ids:Array(String)},trace_id)', 'trace_id IN ('+','.join(escaped)+')')
        if ownership=='user':query+=" AND JSONExtractString(attributes_json,'ownership') IN ('','user')"
        order=direction.upper()
        query+=' ORDER BY started_at_ms '+order+',trace_id '+order+' LIMIT {count:UInt32} OFFSET {offset:UInt64} FORMAT JSONEachRow'
        raw=self._request(query,parameters={'workspace':workspace,'count':count,'offset':offset})
        return [json.loads(line)['trace_id'] for line in raw.splitlines() if line]

    def query_trace_list(self,workspace,routes,plan):
        from .trace_list_sql import query_trace_list
        return query_trace_list(self,workspace,routes,plan)

    def read_root_executions(self,workspace,routes):
        from .trace_list_sql import read_root_executions
        return read_root_executions(self,workspace,routes)

    def read_spans(self, workspace_id, bucket, trace_id, *, status=None, parent_span_id=None, after_span_id='', limit=200, search=None, time_after=None):
        if type(limit) is not int or not 1<=limit<=1000: raise ValueError('page size must be 1..1000')
        parameters=self._scope(workspace_id,bucket,trace_id)
        parameters.update({'limit':limit,'after_span_id':after_span_id})
        predicates=['workspace_id = {workspace_id:String}', 'trace_bucket = {trace_bucket:Date}', 'trace_id = {trace_id:String}', 'is_deleted = 0','span_id > {after_span_id:String}']
        if status is not None:
            predicates.append('execution_status = {status:String}');parameters['status']=status
        if parent_span_id is not None:
            predicates.append('parent_span_id = {parent_span_id:String}');parameters['parent_span_id']=parent_span_id
        if search is not None:
            if not isinstance(search,str) or len(search)>256:raise ValueError('invalid bounded Span search')
            predicates.append("positionCaseInsensitiveUTF8(concat(span_id,' ',name,' ',model),{search:String})>0");parameters['search']=search
        order='span_id'
        if time_after is not None:
            predicates.remove('span_id > {after_span_id:String}')
            parameters.update(after_time=time_after[0],after_id=time_after[1])
            predicates.append('(ifNull(started_at_ms,0),span_id) > ({after_time:UInt64},{after_id:String})')
            order='ifNull(started_at_ms,0),span_id'
        sql='SELECT * FROM obs_span_current FINAL WHERE '+' AND '.join(predicates)+' ORDER BY '+order+' LIMIT {limit:UInt32} FORMAT JSONEachRow'
        return [json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]

    def read_span(self, workspace_id, bucket, trace_id, span_id):
        parameters=self._scope(workspace_id,bucket,trace_id,span_id)
        sql="""SELECT * FROM obs_span_current FINAL WHERE workspace_id = {workspace_id:String}
            AND trace_bucket = {trace_bucket:Date} AND trace_id = {trace_id:String}
            AND span_id = {span_id:String} AND is_deleted = 0 LIMIT 1 FORMAT JSONEachRow"""
        rows=[json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]
        return rows[0] if rows else None

    def write_payload(self, workspace_id, bucket, trace_id, span_id, section, text):
        bundle=self.write_payload_bundle(workspace_id,bucket,trace_id,span_id,{section:text})
        return dict(bundle,**bundle['sections'][section],section=section)

    def write_payload_bundle(self, workspace_id, bucket, trace_id, span_id, sections):
        scope=self._scope(workspace_id,bucket,trace_id,span_id)
        if not isinstance(sections,dict) or not sections or len(sections)>32:
            raise ValueError('payload requires 1..32 named sections')
        metadata={}
        encoded={}
        total=0
        for section,text in sections.items():
            identifier(section)
            if not section.isascii() or not isinstance(text,str):
                raise ValueError('section names are ASCII; payload bodies are Unicode text')
            data=text.encode('utf-8')
            total+=len(data)
            if total>64*1024*1024: raise ValueError('payload exceeds 64MiB; use ArtifactStore streaming')
            encoded[section]=data
            count=0
            for _ in self._chunks(data): count+=1
            metadata[section]={'content_hash':hashlib.sha256(data).hexdigest(),'uncompressed_bytes':len(data),'chunk_count':count,'chunk_hashes':[hashlib.sha256(chunk).hexdigest() for chunk in self._chunks(data)]}
        manifest={'schema_version':1,'sections':metadata}
        bundle_revision=content_hash(manifest)
        for section,data in encoded.items():
            rows=[]
            for i,chunk in enumerate(self._chunks(data)):
                rows.append(dict(scope,payload_revision=bundle_revision,section=section,chunk_no=i,chunk_count=metadata[section]['chunk_count'],uncompressed_bytes=len(chunk),content_hash=hashlib.sha256(chunk).hexdigest(),body=chunk.decode('utf-8'),retry_version=1))
                if len(rows)==4:
                    self._insert('obs_payload_chunks',rows);rows=[]
            if rows: self._insert('obs_payload_chunks',rows)
        self._insert('obs_payload_manifests',[dict(scope,payload_revision=bundle_revision,manifest_json=canonical_json(manifest),retry_version=1)])
        return dict(manifest,payload_revision=bundle_revision)

    def write_payload_bundles(self, payloads):
        if not isinstance(payloads,list) or not 1<=len(payloads)<=128:
            raise ValueError('payload batch must contain 1..128 Spans')
        prepared=[]
        for payload in payloads:
            if not isinstance(payload,dict): raise ValueError('invalid payload bundle')
            scope=self._scope(payload['workspace_id'],payload['trace_bucket'],payload['trace_id'],payload['span_id'])
            sections=payload['sections']
            if not isinstance(sections,dict) or not sections or len(sections)>32:
                raise ValueError('payload requires 1..32 named sections')
            metadata={};total=0
            for section,text in sections.items():
                identifier(section)
                if not section.isascii() or not isinstance(text,str):
                    raise ValueError('section names are ASCII; payload bodies are Unicode text')
                data=text.encode('utf-8');total+=len(data)
                if total>64*1024*1024: raise ValueError('payload exceeds 64MiB; use ArtifactStore streaming')
                hashes=[hashlib.sha256(chunk).hexdigest() for chunk in self._chunks(data)]
                metadata[section]={'content_hash':hashlib.sha256(data).hexdigest(),'uncompressed_bytes':len(data),
                                   'chunk_count':len(hashes),'chunk_hashes':hashes}
            manifest={'schema_version':1,'sections':metadata}
            bundle_revision=content_hash(manifest)
            if payload.get('payload_revision',bundle_revision)!=bundle_revision:
                raise ValueError('payload does not match its frozen revision')
            prepared.append((scope,sections,manifest,bundle_revision))
        rows=[];encoded_size=128
        for scope,sections,manifest,bundle_revision in prepared:
            for section,text in sections.items():
                expected=manifest['sections'][section]
                for number,chunk in enumerate(self._chunks(text.encode('utf-8'))):
                    row=dict(scope,payload_revision=bundle_revision,section=section,chunk_no=number,
                             chunk_count=expected['chunk_count'],uncompressed_bytes=len(chunk),
                             content_hash=expected['chunk_hashes'][number],body=chunk.decode('utf-8'),retry_version=1)
                    size=len(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))+1
                    if rows and (len(rows)>=4096 or encoded_size+size>4*1024*1024):
                        self._insert('obs_payload_chunks',rows);rows=[];encoded_size=128
                    rows.append(row);encoded_size+=size
        if rows: self._insert('obs_payload_chunks',rows)
        # Publishing after every chunk request succeeds keeps interrupted bundles unreadable.
        self._insert('obs_payload_manifests',[dict(scope,payload_revision=bundle_revision,
            manifest_json=canonical_json(manifest),retry_version=1) for scope,_,manifest,bundle_revision in prepared])
        return [dict(manifest,payload_revision=bundle_revision) for _,_,manifest,bundle_revision in prepared]

    @staticmethod
    def _chunks(data):
        if not data:
            yield b''
        position=0
        while position<len(data):
            end=min(position+262144,len(data))
            while end<len(data) and data[end]&0xC0==0x80: end-=1
            yield data[position:end]
            position=end

    def read_payload(self, workspace_id, bucket, trace_id, span_id, payload_revision, section, *, after_chunk=-1, limit=4):
        parameters=self._scope(workspace_id,bucket,trace_id,span_id)
        if type(after_chunk) is not int or after_chunk < -1 or type(limit) is not int or not 1<=limit<=32:
            raise ValueError('invalid bounded chunk page')
        parameters.update(payload_revision=identifier(payload_revision),section=identifier(section),after_chunk=after_chunk,limit=limit)
        manifest_sql="""SELECT manifest_json FROM obs_payload_manifests FINAL
            WHERE workspace_id={workspace_id:String} AND trace_bucket={trace_bucket:Date}
            AND trace_id={trace_id:String} AND span_id={span_id:String}
            AND payload_revision={payload_revision:String} FORMAT JSONEachRow"""
        try:
            published=[json.loads(line) for line in self._request(manifest_sql,parameters=parameters).splitlines() if line]
            if len(published)!=1: raise IncompletePayload('payload is not published')
            manifest=json.loads(published[0]['manifest_json'])
            if content_hash(manifest)!=payload_revision: raise IncompletePayload('payload manifest root mismatch')
            if type(manifest.get('schema_version')) is not int or manifest['schema_version']!=1:
                raise IncompletePayload('unsupported payload manifest schema')
            if not isinstance(manifest.get('sections'),dict):raise IncompletePayload('invalid payload manifest')
            if section not in manifest['sections']:
                return {'chunks':[],'chunk_count':0,'next_chunk':None,'complete':True,'available':False}
            expected=manifest['sections'][section]
            if (type(expected['chunk_count']) is not int or expected['chunk_count']<=0
                or type(expected['uncompressed_bytes']) is not int or expected['uncompressed_bytes']<0
                or not re.fullmatch(r'[0-9a-f]{64}',expected['content_hash'])
                or len(expected['chunk_hashes'])!=expected['chunk_count']
                or not all(isinstance(h,str) and re.fullmatch(r'[0-9a-f]{64}',h) for h in expected['chunk_hashes'])):
                raise IncompletePayload('invalid payload section manifest')
        except (KeyError,TypeError,ValueError) as exc:
            raise IncompletePayload('invalid payload manifest') from exc
        sql='''SELECT chunk_no,chunk_count,uncompressed_bytes,content_hash,body FROM obs_payload_chunks FINAL
            WHERE workspace_id={workspace_id:String} AND trace_bucket={trace_bucket:Date}
            AND trace_id={trace_id:String} AND span_id={span_id:String}
            AND payload_revision={payload_revision:String} AND section={section:String}
            AND toInt64(chunk_no)>{after_chunk:Int64} ORDER BY chunk_no LIMIT {limit:UInt32} FORMAT JSONEachRow'''
        rows=[json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]
        if not rows: raise IncompletePayload('requested payload page is missing')
        counts={int(row['chunk_count']) for row in rows}
        if len(counts)!=1 or next(iter(counts))!=expected['chunk_count'] or next(iter(counts))<=0: raise IncompletePayload('inconsistent payload manifest')
        total=next(iter(counts))
        for index,row in enumerate(rows,after_chunk+1):
            raw=row['body'].encode('utf-8')
            if int(row['chunk_no'])!=index or index>=total or len(raw)!=int(row['uncompressed_bytes']) or hashlib.sha256(raw).hexdigest()!=row['content_hash'] or row['content_hash']!=expected['chunk_hashes'][index]:
                raise IncompletePayload('payload chunk is missing or corrupt')
        if len(rows)<limit and int(rows[-1]['chunk_no'])+1<total:
            raise IncompletePayload('payload was only partially written')
        if after_chunk==-1 and len(rows)==total:
            whole=''.join(row['body'] for row in rows).encode('utf-8')
            if len(whole)!=expected['uncompressed_bytes'] or hashlib.sha256(whole).hexdigest()!=expected['content_hash']:
                raise IncompletePayload('payload section root mismatch')
        return {'chunks':rows,'chunk_count':total,'next_chunk':int(rows[-1]['chunk_no']) if int(rows[-1]['chunk_no'])+1<total else None,'complete':after_chunk==-1 and len(rows)==total}

    def summarize_spans(self, workspace_ids, bucket_from, bucket_to, *, trace_ids=None, excluded_trace_ids=None):
        if not isinstance(workspace_ids,(tuple,list)) or not 1<=len(workspace_ids)<=1000 or len(set(workspace_ids))!=len(workspace_ids):
            raise ValueError('analytics requires 1..1000 explicit distinct workspaces')
        start=datetime.date.fromisoformat(bucket_from)
        end=datetime.date.fromisoformat(bucket_to)
        if start>end:
            raise ValueError('invalid bucket range')
        if trace_ids is not None and (not isinstance(trace_ids,dict) or set(trace_ids)!=set(workspace_ids)):
            raise ValueError('Trace selection must match workspace selection')
        if excluded_trace_ids is not None and (not isinstance(excluded_trace_ids,dict) or not set(excluded_trace_ids)<=set(workspace_ids)):
            raise ValueError('invalid deletion barrier scope')
        parameters={'bucket_from':bucket_from,'bucket_to':bucket_to}
        predicates=[]
        for i,workspace_id in enumerate(workspace_ids):
            key=f'workspace_{i}'
            parameters[key]=identifier(workspace_id)
            predicate=f'workspace_id = {{{key}:String}}'
            if trace_ids is not None:
                roots=trace_ids[workspace_id]
                if not isinstance(roots,(tuple,list)) or not 1<=len(roots)<=1000:
                    raise ValueError('Trace selection must contain 1..1000 roots per workspace')
                selections=[]
                for j,trace_id in enumerate(roots):
                    trace_key=f'trace_{i}_{j}'
                    parameters[trace_key]=identifier(trace_id)
                    selections.append('{'+trace_key+':String}')
                predicate+=' AND trace_id IN ('+','.join(selections)+')'
            excluded=(excluded_trace_ids or {}).get(workspace_id,[])
            if not isinstance(excluded,(tuple,list)) or len(excluded)>1000:
                raise ValueError('deletion barrier must contain at most 1000 roots per workspace')
            if excluded:
                exclusions=[]
                for j,trace_id in enumerate(excluded):
                    excluded_key=f'excluded_{i}_{j}'
                    parameters[excluded_key]=identifier(trace_id)
                    exclusions.append('{'+excluded_key+':String}')
                predicate+=' AND trace_id NOT IN ('+','.join(exclusions)+')'
            predicates.append('('+predicate+')')
        if len(parameters)>4096:
            raise ValueError('analytics scope exceeds bounded query parameter count')
        sql='SELECT count() AS span_count, coalesce(sum(input_tokens),0) AS input_tokens_known_sum, coalesce(sum(output_tokens),0) AS output_tokens_known_sum, countIf(isNull(input_tokens)) AS input_tokens_missing_count, countIf(isNull(output_tokens)) AS output_tokens_missing_count FROM obs_span_current FINAL WHERE is_deleted = 0 AND trace_bucket >= {bucket_from:Date} AND trace_bucket <= {bucket_to:Date} AND ('+' OR '.join(predicates)+') FORMAT JSONEachRow'
        rows=[json.loads(line) for line in self._request(sql,parameters=parameters).splitlines() if line]
        if len(rows)!=1:
            raise ClickHouseError('invalid bounded analytics response')
        result={key:int(rows[0][key]) for key in ('span_count','input_tokens_known_sum','output_tokens_known_sum','input_tokens_missing_count','output_tokens_missing_count')}
        for direction in ('input','output'):
            result[direction+'_tokens']=None if result[direction+'_tokens_missing_count'] else result[direction+'_tokens_known_sum']
        return result
