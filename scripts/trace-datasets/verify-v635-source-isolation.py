"""Independently check exclusion using sparse all-pairs token intersections."""
import hashlib,json,re,sys,unicodedata
from pathlib import Path
import numpy as np
from scipy.sparse import csr_matrix
root,old=map(Path,sys.argv[1:3]);manifest=json.loads((root/'pool-manifest.json').read_text())
def norm(s):return unicodedata.normalize('NFC',s.replace('\r\n','\n').replace('\r','\n'))
def terms(s):return frozenset(re.findall(r'[^\W_]+',re.sub(r'([\u3400-\u4dbf\u4e00-\u9fff])',r' \1 ',norm(s).lower())))
sha=lambda b:hashlib.sha256(b).hexdigest()
old_text=set();old_terms=set();old_groups=set();old_summary=set()
for filename,h in manifest['oldSourceHashes'].items():
 b=(old/filename).read_bytes();assert sha(b)==h
 for r in json.loads(b):
  old_text.add(norm(r['input']));old_terms.add(terms(r['input']));old_groups.add(filename[:-5]+':'+str(r['group']))
  if filename=='SummarizeFeedback.json':old_summary.add(str(r['group']))
new={};components={}
raw=json.loads((root/'new-mapped.json').read_text());raw_by_key={}
for r in raw:
 key=sha(json.dumps([r['input'],r['answer']],ensure_ascii=False,separators=(',',':')).encode());raw_by_key.setdefault((r['source'],key),[]).append(r)
for name,s in manifest['sources'].items():
 b=(root/(name+'-text.json')).read_bytes();assert sha(b)==s['textSha256']
 for r in json.loads(b):
  assert norm(r['input']) not in old_text
  for source in raw_by_key[name,r['key']]:
   assert name+':'+source['group'] not in old_groups
   if name=='SummEval':assert source['group'] not in old_summary
  t=terms(r['input']);new.setdefault(t,[]).append((name,r['key']));components.setdefault(t,set()).add(r['component'])
assert all(len(v)==1 for v in components.values())
vocab={}
def matrix(sets):
 indices=[];indptr=[0]
 for ts in sets:
  for token in ts:indices.append(vocab.setdefault(token,len(vocab)))
  indptr.append(len(indices))
 return indices,indptr
old_sets=list(old_terms);new_sets=list(new);oi,op=matrix(old_sets);ni,np_=matrix(new_sets);shape=len(vocab)
a=csr_matrix((np.ones(len(oi),dtype=np.int32),np.array(oi),np.array(op)),shape=(len(old_sets),shape));b=csr_matrix((np.ones(len(ni),dtype=np.int32),np.array(ni),np.array(np_)),shape=(len(new_sets),shape));old_lengths=np.array([len(t) for t in old_sets]);new_lengths=np.array([len(t) for t in new_sets]);maximum=0.0
for start in range(0,len(new_sets),64):
 intersections=(b[start:start+64]@a.T).tocoo();unions=new_lengths[start+intersections.row]+old_lengths[intersections.col]-intersections.data;scores=intersections.data/unions
 if len(scores):maximum=max(maximum,float(scores.max()));assert not np.any(scores>=.8),('near duplicate leaked',start,float(scores.max()))
print('old vs new all-pairs token Jaccard verified',len(old_sets),len(new_sets),flush=True)
# Near-equal new inputs must remain in the same source-panel component.
for start in range(0,len(new_sets),64):
 cross=(b[start:start+64]@b.T).tocoo();unions=new_lengths[start+cross.row]+new_lengths[cross.col]-cross.data
 for i,j in zip(cross.row[cross.data/unions>=.8],cross.col[cross.data/unions>=.8]):
  assert components[new_sets[start+int(i)]]==components[new_sets[int(j)]]
out={'passed':True,'oldUniqueTokenSets':len(old_sets),'newUniqueTokenSets':len(new_sets),'maximumOldNewTokenJaccard':maximum,'sources':len(manifest['sources']),'checks':['all old mapped raw SHA matches','no exact normalized old input','no original source group/article overlap','exhaustive sparse new-old token Jaccard <0.8','new-new Jaccard >=0.8 shares a source component'],'poolManifestSha256':sha((root/'pool-manifest.json').read_bytes()),'scriptSha256':sha(Path(__file__).read_bytes())}
(root/'source-isolation-verification.json').write_text(json.dumps(out,indent=2));print(json.dumps(out),flush=True)
