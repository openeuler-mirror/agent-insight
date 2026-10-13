import concurrent.futures, datetime, hashlib, json, os, sys, time, urllib.parse, urllib.request, urllib.error
root = sys.argv[1]
os.makedirs(root, exist_ok=True)
repos = ['allenai/WildChat', 'databricks/databricks-dolly-15k', 'nvidia/HelpSteer2']
def get(url):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=90) as response: return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in [429, 500, 502, 503] or attempt == 5: raise
            time.sleep(min(60, int(error.headers.get('Retry-After') or 5 * 2 ** attempt)))
def download(repo):
    info = get('https://huggingface.co/api/datasets/' + repo)
    splits = get('https://datasets-server.huggingface.co/splits?' + urllib.parse.urlencode({'dataset': repo}))['splits']
    split = next(s for s in splits if s['split'] == 'train' and s['config'] == 'default')
    rows = []
    for offset in range(0, 1000, 100):
        url = 'https://datasets-server.huggingface.co/rows?' + urllib.parse.urlencode({'dataset': repo, 'config': split['config'], 'split': 'train', 'offset': offset, 'length': 100})
        batch = get(url)
        if batch.get('truncated'): raise RuntimeError('truncated response')
        for item in batch['rows']:
            if item.get('truncated_cells'): raise RuntimeError('truncated row')
            row = item['row']
            if repo.startswith('allenai/'):
                conv = row['conversation']
                if len(conv)<2 or conv[0]['role']!='user' or conv[1]['role']!='assistant': continue
                mapped = {'input':conv[0]['content'],'reference_output':conv[1]['content'],'group':row.get('conversation_hash',str(item['row_idx'])),'language':row.get('language'),'laterTurnsSkipped':max(0,len(conv)-2)}
            elif repo.startswith('databricks/'):
                mapped = {'input':row['instruction']+ ('\n\n'+row['context'] if row['context'] else ''),'reference_output':row['response'],'category':row['category'],'language':'English'}
            else:
                mapped = {'input':row['prompt'],'reference_output':row['response'],'quality':{k:row[k] for k in ['helpfulness','correctness','coherence','complexity','verbosity']},'language':'English'}
            mapped['rowId']=item['row_idx']; rows.append(mapped)
    filename = repo.split('/')[-1]+'.json'
    content = json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()
    with open(os.path.join(root,filename),'wb') as out: out.write(content)
    return {'repo':repo,'revision':info['sha'],'license':info.get('cardData',{}).get('license'),'config':'default','split':'train','selection':'first 1000 rows; convenience subset, not population representative','rows':len(rows),'file':filename,'sha256':hashlib.sha256(content).hexdigest(),'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mapping':'trace-public-v1','source':'https://huggingface.co/datasets/'+repo}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    manifest=list(pool.map(download,repos))
with open(os.path.join(root,'manifest.json'),'w') as out:json.dump(manifest,out,indent=2)
print(json.dumps([{k:v for k,v in row.items() if k!='source'} for row in manifest],indent=2))
