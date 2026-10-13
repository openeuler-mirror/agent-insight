"""Fetch new public sources and exclude all previously accessed source/input groups."""
import concurrent.futures, gzip, hashlib, json, math, random, re, sys, time, unicodedata
from pathlib import Path
import requests
import pyarrow.parquet as pq
import pyarrow as pa

root=Path(sys.argv[1]); old=Path(sys.argv[2]); root.mkdir(parents=True,exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
norm=lambda t:unicodedata.normalize('NFC',t.replace('\r\n','\n').replace('\r','\n'))
def tokens(t):
    t=re.sub(r'([\u3400-\u4dbf\u4e00-\u9fff])',r' \1 ',norm(t).lower())
    return re.findall(r'[^\W_]+',t)
def lex(t):return ' '.join(tokens(t))
files=[]
unavailable={}
def fetch(url,dest):
    if dest.exists(): b=dest.read_bytes()
    else:
        for attempt in range(4):
            try:
                r=requests.get(url,timeout=(15,75));r.raise_for_status();b=r.content;dest.write_bytes(b);break
            except requests.RequestException as exc:
                if getattr(exc,'response',None) is not None and exc.response.status_code==429:raise
                if attempt==3:raise
                time.sleep(2**attempt)
    return b,dict(file=dest.name,url=url,sha256=sha(b),bytes=len(b))
def pinned(name,filename):
    m=json.loads((root/(name+'-metadata.json')).read_text()); repo=m['id']
    b,f=fetch(f"https://huggingface.co/datasets/{repo}/resolve/{m['sha']}/{filename}",root/(name+'-'+filename.replace('/','--')));files.append(f);return b
rows=[]
def add(name,i,a,g,rid,q=None):
    if isinstance(i,str) and isinstance(a,str) and i.strip() and a.strip():
        rows.append(dict(source=name,input=norm(i),answer=norm(a),group=str(g),rowId=str(rid),quality=q or {}))
def first(messages):
    for n,m in enumerate(messages):
        if m.get('role',m.get('from')) in ['user','human','prompter']:
            for a in messages[n+1:]:
                if a.get('role',a.get('from')) in ['assistant','gpt']:return m.get('content',m.get('value')),a.get('content',a.get('value'))
            break
    return None
for name in ['HelpSteer2','OASST2','NoRobots']:
    if name=='HelpSteer2':
        data=[json.loads(x) for x in gzip.decompress(pinned(name,'validation.jsonl.gz')).splitlines()]
        for i,r in enumerate(data):add(name,r['prompt'],r['response'],sha(r['prompt'].encode()),i,{k:r[k] for k in ['helpfulness','correctness','coherence','complexity','verbosity']})
    else:
        m=json.loads((root/(name+'-metadata.json')).read_text());file=next(f['rfilename'] for f in m['siblings'] if f['rfilename'].startswith('data/'+('validation-' if name=='OASST2' else 'test-')) and f['rfilename'].endswith('.parquet'))
        data=pq.read_table(pa.BufferReader(pinned(name,file))).to_pylist()
        if name=='NoRobots':
            for i,r in enumerate(data):
                p=first(r['messages'])
                if p:add(name,*p,r['prompt_id'],i)
        else:
            ids={r['message_id']:r for r in data}
            for r in data:
                p=ids.get(r.get('parent_id'))
                if r['role']!='assistant' or not p or p['role']!='prompter' or p['parent_id'] is not None or r.get('deleted') or p.get('deleted'):continue
                labels=r.get('labels') or {}
                if isinstance(labels,dict):labels=[dict(name=n,value=v) for n,v in zip(labels.get('name',[]),labels.get('value',[]))]
                add(name,p['text'],r['text'],r['message_tree_id'],r['message_id'],{x['name']:x['value'] for x in labels if x['name']=='quality' and isinstance(x['value'],(int,float))})
    print('mapped',name,len([r for r in rows if r['source']==name]),flush=True)
for name in ['WildChat','UltraChat']:
    try:
        m=json.loads((root/(name+'-metadata.json')).read_text());repo=m['id'];size,f=fetch('https://datasets-server.huggingface.co/size?dataset='+repo,root/(name+'-size.json'));files.append(f)
        total=next(s['num_rows'] for s in json.loads(size)['size']['splits'] if s['split']=='train' and s['config']=='default')
        legacy=json.loads((old/name/'manifest.json').read_text());seen={int(re.search(r'page-(\d+)',f['file'])[1]) for f in legacy['files'] if 'page-' in f['file']}
        choices=sorted(set(range(math.ceil(total/100)))-seen);pages=sorted(random.Random(20261013).sample(choices,min(60,len(choices))))
        def page(n):
            url=f'https://datasets-server.huggingface.co/rows?dataset={repo}&config=default&split=train&offset={n*100}&length={min(100,total-n*100)}'
            b,f=fetch(url,root/f'{name}-page-{n}.json');d=json.loads(b)
            assert not d.get('truncated') and not any(x.get('truncated_cells') for x in d['rows'])
            return d['rows'],f
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            for j,(batch,f) in enumerate(pool.map(page,pages)):
                files.append(f)
                for e in batch:
                    r=e['row']
                    if name=='WildChat':p=first(r.get('conversation',[]));g=r.get('conversation_id',r.get('conversation_hash',e['row_idx']))
                    else:p=r['data'][:2] if len(r.get('data',[]))>=2 else None;g=r.get('id',e['row_idx'])
                    if p:add(name,*p,g,e['row_idx'])
                if (j+1)%10==0:print('pages',name,j+1,len(pages),flush=True)
        check=requests.get('https://huggingface.co/api/datasets/'+repo,timeout=45);check.raise_for_status();assert check.json()['sha']==m['sha']
    except requests.RequestException as exc:
        unavailable[name]=str(exc);rows=[r for r in rows if r['source']!=name];print('source unavailable',name,str(exc),flush=True)
# The authors' aligned annotation file omits article text; join the official CNN/DM article ID.
b=(root/'summeval-annotations.jsonl').read_bytes();files.append(dict(file='summeval-annotations.jsonl',url='https://storage.googleapis.com/sfr-summarization-repo-research/model_annotations.aligned.jsonl',sha256=sha(b),bytes=len(b)))
a=[json.loads(x) for x in b.splitlines()]
m=json.loads((root/'cnn-metadata.json').read_text()); filename=next(f['rfilename'] for f in m['siblings'] if '3.0.0/test-' in f['rfilename'] and f['rfilename'].endswith('.parquet'))
b,f=fetch(f"https://huggingface.co/datasets/{m['id']}/resolve/{m['sha']}/{filename}?download=true",root/'cnn-test.parquet');files.append(f)
articles={r['id']:r['article'] for r in pq.read_table(pa.BufferReader(b)).to_pylist()}
for i,r in enumerate(a):
    key=r['id'].split('-')[-1]; assert key in articles,(key,'missing article')
    q={k:sum(x[k] for x in r['expert_annotations'])/len(r['expert_annotations']) for k in r['expert_annotations'][0]}
    add('SummEval','Summarize the following article:\n\n'+articles[key],r['decoded'],key,i,q)
(root/'download-manifest.json').write_text(json.dumps(files,indent=2));(root/'new-mapped.json').write_text(json.dumps(rows,ensure_ascii=False))
print('mapped all',len(rows),flush=True)
# Preserve related examples together and exclude entire components, including bridge records.
parent={}
def find(x):
    parent.setdefault(x,x)
    if parent[x]!=x:parent[x]=find(parent[x])
    return parent[x]
def union(a,b):
    a,b=find(a),find(b)
    if a!=b:parent[max(a,b)]=min(a,b)
old_groups=set();old_ids=set();old_exact=set();old_lex=set();old_sets=[];seen_sets=set();old_hashes={}
for p in old.glob('*.json'):
    data=p.read_bytes();old_hashes[p.name]=sha(data)
    for r in json.loads(data):
        if not isinstance(r,dict) or 'input' not in r:continue
        old_groups.add(p.stem+':'+str(r['group']));old_ids.add(str(r['group']));old_exact.add(norm(r['input']));lt=lex(r['input']);old_lex.add(lt)
        ts=frozenset(lt.split())
        if ts and ts not in seen_sets:seen_sets.add(ts);old_sets.append(ts)
postings={}
for i,ts in enumerate(old_sets):
    for t in ts:postings.setdefault(t,[]).append(i)
print('old unique token sets',len(old_sets),flush=True)
near_cache={};blocked=set();reasons={}; groups_for_input={}
for r in rows:
    g=r['source']+':'+r['group'];lt=lex(r['input']);r['_lex']=lt
    ik='input:'+sha(lt.encode());union('group:'+g,ik)
    reason=None
    if g in old_groups or (r['source']=='SummEval' and r['group'] in old_ids):reason='source_group'
    elif r['input'] in old_exact:reason='exact_input'
    elif lt in old_lex:reason='lexical_input'
    elif lt not in near_cache:
        ts=set(lt.split());matches=set()
        prefix=sorted(ts,key=lambda t:(len(postings.get(t,[])),t))[:len(ts)-math.ceil(.8*len(ts))+1]
        for t in prefix:matches.update(postings.get(t,[]))
        near_cache[lt]=any(.8*len(ts)<=len(old_sets[i])<=len(ts)/.8 and len(ts&old_sets[i])/len(ts|old_sets[i])>=.8 for i in matches) if ts else False
    if reason is None and near_cache.get(lt):reason='token_jaccard_ge_0.8'
    if reason:blocked.add('group:'+g);reasons[r['source']+':'+r['rowId']]=reason
blocked_roots={find(g) for g in blocked}
accepted=[r for r in rows if find('group:'+r['source']+':'+r['group']) not in blocked_roots]
for r in accepted:r['component']=find('group:'+r['source']+':'+r['group'])
# Also join near-duplicate confirmation inputs so disjoint panels do not split them.
new_sets={};new_posts={}
for r in accepted:
    lt=r['_lex'];ts=set(lt.split())
    if lt in new_sets:continue
    candidates=set();prefix=sorted(ts,key=lambda t:(len(new_posts.get(t,[])),t))[:len(ts)-math.ceil(.8*len(ts))+1]
    for t in prefix:candidates.update(new_posts.get(t,[]))
    for other in candidates:
        os=new_sets[other]
        if .8*len(ts)<=len(os)<=len(ts)/.8 and len(ts&os)/len(ts|os)>=.8:union('input:'+sha(lt.encode()),'input:'+sha(other.encode()))
    new_sets[lt]=ts
    for t in ts:new_posts.setdefault(t,[]).append(lt)
manifest={'unavailable':unavailable,'oldSourceHashes':old_hashes,'downloadManifestSha256':sha((root/'download-manifest.json').read_bytes()),'sources':{},'exclusionRule':'entire connected group if source, exact/lexical input, or >=0.8 token-set Jaccard overlaps any old raw input'}
for name in sorted({r['source'] for r in rows}):
    pairs={}
    for r in accepted:
        if r['source']!=name:continue
        key=sha(json.dumps([r['input'],r['answer']],ensure_ascii=False,separators=(',',':')).encode());p=pairs.setdefault(key,dict(key=key,input=r['input'],answer=r['answer'],component=find('group:'+name+':'+r['group']),quality={}))
        for axis,v in r['quality'].items():p['quality'].setdefault(axis,[]).append(v)
    groups={}
    for p in pairs.values():groups.setdefault(p['component'],[]).append(p)
    ordered=sorted(groups,key=lambda g:sha(('confirmation-pool-20261013:'+g).encode()));chosen=[]
    for g in ordered:
        if len(chosen)+len(groups[g])<=5000:chosen+=groups[g]
    texts=[];labels={}
    for p in chosen:
        labels[p['key']]={a:sum(v)/len(v) for a,v in p.pop('quality').items()};texts.append(p)
    payload=json.dumps(texts,ensure_ascii=False,separators=(',',':')).encode();label_bytes=json.dumps(labels,separators=(',',':')).encode()
    (root/(name+'-text.json')).write_bytes(payload);(root/(name+'-labels.json')).write_bytes(label_bytes)
    manifest['sources'][name]={'mapped':sum(r['source']==name for r in rows),'acceptedRows':sum(r['source']==name for r in accepted),'excludedRows':sum(r['source']==name for r in rows)-sum(r['source']==name for r in accepted),'uniquePairs':len(pairs),'poolPairs':len(texts),'poolGroups':len(set(p['component'] for p in texts)),'textSha256':sha(payload),'labelsSha256':sha(label_bytes),'directExclusionReasons':{reason:sum(k.startswith(name+':') and v==reason for k,v in reasons.items()) for reason in set(reasons.values())}}
    print(name,manifest['sources'][name],flush=True)
(root/'pool-manifest.json').write_text(json.dumps(manifest,indent=2))
