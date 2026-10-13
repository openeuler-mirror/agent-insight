"""Summarize a frozen held-out run without selecting a new algorithm or threshold."""
import gzip,hashlib,json,random,shutil,sys
from pathlib import Path
from statistics import mean
root,docs=map(Path,sys.argv[1:3]);out=docs/'examples'/'v635-independent-20261013';out.mkdir(exist_ok=True,parents=True)
a=json.loads((root/'audited-metrics.json').read_text());assert a['passed']
p=json.loads((root/'protocol.json').read_text());manifest=json.loads((root/'pool-manifest.json').read_text())
sha=lambda b:hashlib.sha256(b).hexdigest()
methods=p['methods'];allrows=a['scenarios']
def interval(values):
 if len(values)<2:return None
 rng=random.Random(20261013);means=sorted(mean(rng.choices(values,k=len(values))) for _ in range(10000));return [means[249],means[9749]]
def estimate(rows,m,metric):
 values=[r['methods'][m][metric] for r in rows];return mean(values)
def qmean(rows,m,axis):
 v=[r['methods'][m]['quality'][axis]['mean'] for r in rows if axis in r['methods'][m]['quality']];return mean(v) if v else None
summary={'algorithm':'V635','source':str(root),'protocolSha256':a['protocolSha256'],'algorithmRetuned':False,'default':'trace-coverage-v4','scenarios':len(allrows),'methodRuns':len(allrows)*len(methods),'coverage':[],'quality':[],'sensitivity':[],'limitations':['No production Worker/UI validation','Original Dolly, ShareGPT4 and SummarizeFeedback sources exhausted for independent confirmation','Seed intervals describe fixed-pool random-seed uncertainty only','Five small disjoint panels give limited transfer evidence; no population-wide or multiplicity-adjusted significance claim','Human quality calculated only for selected rows with available annotations; label counts reported','Public text experiments have no observed tool behavior'], 'unavailable':manifest['unavailable']}
for name in manifest['sources']:
 rows=[r for r in allrows if r['source']==name and r['pool']=='full' and r['k']==100];assert len(rows)==20
 c={'source':name,'n':rows[0]['n'],'groups':rows[0]['groups'],'methods':{m:{k:estimate(rows,m,k) for k in ['vocabulary','matchedVocabulary','tokens']} for m in methods},'feasible':sum(r['methods']['V635']['feasible'] for r in rows),'trials':20}
 c['v635GainOverRandom']=100*(c['methods']['V635']['vocabulary']/c['methods']['B0']['vocabulary']-1)
 c['v635GainOverV5']=100*(c['methods']['V635']['vocabulary']/c['methods']['V5']['vocabulary']-1)
 c['matchedGainOverV5']=100*(c['methods']['V635']['matchedVocabulary']/c['methods']['V5']['matchedVocabulary']-1)
 c['coveragePassed']=c['v635GainOverV5']>=0 and c['matchedGainOverV5']>=0 and c['feasible']==20
 c['seedDelta95']=interval([r['methods']['V635']['matchedVocabulary']-r['methods']['V5']['matchedVocabulary'] for r in rows])
 panels=sorted(set(r['pool'] for r in allrows if r['source']==name and r['pool']!='full'))
 c['panelCount']=len(panels);c['panelMatchedDeltas']=[mean(r['methods']['V635']['matchedVocabulary']-r['methods']['V5']['matchedVocabulary'] for r in allrows if r['source']==name and r['pool']==panel) for panel in panels];c['panelDelta95']=interval(c['panelMatchedDeltas']);summary['coverage'].append(c)
 axes=sorted(set(axis for r in rows for m in methods for axis in r['methods'][m]['quality']))
 for axis in axes:
  span=1 if name=='OASST2' else 4
  coherent=name=='SummEval' and axis=='coherence';margin=span*(.006 if coherent else .01)
  q={'source':name,'axis':axis,'decisionAxis':axis in p['qualityDecisionAxes'].get(name,[]),'means':{m:qmean(rows,m,axis) for m in methods},'labeledMean':{m:mean(r['methods'][m]['quality'].get(axis,{}).get('labeled',0) for r in rows) for m in methods},'margin':margin,'comparisons':{}}
  for b in ['B0','V4','V5','V632']:
   deltas=[r['methods']['V635']['quality'][axis]['mean']-r['methods'][b]['quality'][axis]['mean'] for r in rows if axis in r['methods']['V635']['quality'] and axis in r['methods'][b]['quality']]
   pd=[]
   for panel in panels:
    z=[r['methods']['V635']['quality'][axis]['mean']-r['methods'][b]['quality'][axis]['mean'] for r in allrows if r['source']==name and r['pool']==panel and axis in r['methods']['V635']['quality'] and axis in r['methods'][b]['quality']]
    if z:pd.append(mean(z))
   d=mean(deltas) if deltas else None;ci=interval(pd)
   q['comparisons'][b]={'delta':d,'seedDelta95':interval(deltas),'panelDeltas':pd,'panelDelta95':ci,'pointPassed':d is not None and d>=(-margin if coherent else 0),'panelNoninferioritySupported':ci is not None and ci[0]>=-margin}
  q['pointPassed']=all(q['comparisons'][b]['pointPassed'] for b in ['B0','V4','V5'])
  q['panelAndFullPointChecksPassed']=q['pointPassed'] and len(panels)==5 and all(q['comparisons'][b]['panelNoninferioritySupported'] for b in ['B0','V4','V5'])
  if (name,axis) in [('OASST2','quality'),('HelpSteer2','helpfulness')]:q['legacyFloor']=.729 if name=='OASST2' else 2.910;q['legacyFloorPassed']=q['means']['V635'] is not None and q['means']['V635']>=q['legacyFloor']
  summary['quality'].append(q)
 for r in allrows:
  if r['source']==name and r['pool']=='full' and r['k']!=100:summary['sensitivity'].append({'source':name,'k':r['k'],'n':r['n'],'feasible':r['methods']['V635']['feasible'],'count':r['methods']['V635']['count']})
summary['allAvailablePointChecksPassed']=all(r['coveragePassed'] for r in summary['coverage']) and all(q['pointPassed'] for q in summary['quality'] if q['decisionAxis']) and all(r['feasible'] for r in summary['sensitivity'])
summary['legacyQualityFloorsPassed']=all(q.get('legacyFloorPassed',True) for q in summary['quality'])
summary['generalImprovementEstablished']=False
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
for f in ['protocol.json','pool-manifest.json','download-manifest.json','audited-metrics.json','frozen-original-code.json','validation.json','source-isolation-verification.json','negative-control.json']:
 if (root/f).exists():shutil.copyfile(root/f,out/f)
for name in manifest['sources']:
 with (out/(name+'-selections.json.gz')).open('wb') as f:
  with gzip.GzipFile(filename='',mode='wb',fileobj=f,mtime=0) as z:z.write((root/(name+'-selections.json')).read_bytes())
table=lambda h,rs:'\n'.join(['| '+' | '.join(h)+' |','| '+' | '.join(['---']*len(h))+' |']+['| '+' | '.join(map(str,r))+' |' for r in rs])
fmt=lambda v:'不足' if v is None else f'{v:.4f}'
coverage=table(['新来源','候选 / 来源组','相对随机覆盖','相对 v5 覆盖','同 token 相对 v5','可行次数'],[[r['source'],f"{r['n']} / {r['groups']}",f"{r['v635GainOverRandom']:+.2f}%",f"{r['v635GainOverV5']:+.2f}%",f"{r['matchedGainOverV5']:+.2f}%",f"{r['feasible']}/20"] for r in summary['coverage']])
quality=table(['来源 / 人工评分轴','随机','v4','v5','v6.32','v6.35','均值要求'],[[q['source']+' / '+q['axis'],*[fmt(q['means'][m]) for m in methods],('通过' if q['pointPassed'] else '未通过') if q['decisionAxis'] else '描述性指标'] for q in summary['quality']])
ci=table(['来源 / 轴','v6.35−v4','同池种子差值 95% 区间','来源面板差值 95% 区间','面板数'],[[q['source']+' / '+q['axis'],fmt(q['comparisons']['V4']['delta']),str(q['comparisons']['V4']['seedDelta95']),str(q['comparisons']['V4']['panelDelta95']),len(q['comparisons']['V4']['panelDeltas'])] for q in summary['quality'] if q['decisionAxis']])
availability=table(['来源','映射新记录','因旧来源/相似输入排除','最终候选 / 来源组'],[[n,v['mapped'],v['excludedRows'],f"{v['poolPairs']} / {v['poolGroups']}"] for n,v in manifest['sources'].items()])
text=f'''## v6.35 独立来源确认（2026-10-13）

**冻结 v6.35 后新增 {len(allrows)} 个场景、{summary['methodRuns']} 次方法运行；没有根据确认结果调整算法。** 本节为新数据证据，不覆盖旧开发池的 11/11 结论。当前仍不能宣布通用改进已得到完整验证，默认保持 v4。**完整新池中，5 个来源的覆盖均不低于 v5；OASST2 和 SummEval 的人工质量有所提高，但 HelpSteer2 helpfulness 为 2.775，低于随机 2.891 和 v4 的 2.8215，correctness 也低于随机。** 这支持部分收益能够迁移，不支持所有数据集质量普遍提高。旧池调整后的两个主质量绝对下限在新池均未达到；OASST2 新旧标注选样口径不同，不能把绝对差直接归因于过拟合。逐项结果如下；可用来源均值检查总状态：{'通过，但独立统计支持与缺失来源仍需补足' if summary['allAvailablePointChecksPassed'] else '未全部通过'}。

### 确认来源与隔离

{availability}

旧的八源整份映射原始数据全部列入排除集，不只排除旧候选池或入选记录；按来源 ID、规范化输入、词法输入及 token 集 Jaccard ≥0.8 检查，排除关联来源组。新确认集内部相同/近重复输入保留在同一来源面板。近重复检查属于词法规则，不能保证识别语义改写。固定来源 ID 与文本、标注、下载响应及算法 SHA；选样进程只读取文本文件，全部选样 ID 写入后审计进程才读取评分。没有 LLM、源名称特定的采样规则或新增产品存储。

HelpSteer2 使用官方 validation，OASST2 使用 validation 的根提示直接回答，NoRobots 使用官方 test，WildChat/UltraChat 预定 60 个此前未采集的数据页。摘要采用 [SummEval 作者发布的专家标注](https://github.com/Yale-LILY/SummEval#human-annotations)，按文章 ID 关联 CNN/DailyMail 正文，作为新来源迁移测试；它不是原 SummarizeFeedback 分层，评分为 1–5，不能套用 6.339 的旧量表绝对下限。

未取得来源：{'; '.join(k+': '+v for k,v in manifest['unavailable'].items()) or '本轮预定新增来源均取得'}。Dolly、ShareGPT4 及原 SummarizeFeedback 的完整来源此前已访问，本轮没有将其剩余记录重新划为独立确认。没有这些来源及真实业务 Trace 的确认，不能宣称八源或任意业务全面泛化。

### 覆盖与成本约束

{coverage}

每个完整池 K=100，固定种子 200–219；另做 seed=200、K=20/500。来源不足时使用实际数量，不复制补满 5,000。表中“同 token”沿用 QA ID 散列排序和共同最小预算；输入长度不同时必须同时看两种覆盖。feasible 为预算、分布等约束可行次数，回退 v4 不算候选成功。新确认数据没有真实工具路径，不能替代工具行为覆盖验收。

### 全部人工评分

{quality}

HelpSteer2 的 complexity/verbosity 不是越高越好，仅描述；其新增 coherence 也完整列出，不替代原 helpfulness/correctness 验收。原质量下限仍另列：OASST2 ≥0.729，HelpSteer2 ≥2.910；新 OASST2 全池含未标注回答，均值仅基于入选且有评分的记录，标注分母见 JSON，不能与旧 quality-annotated 选样池直接等同。摘要 coherence 在新 1–5 量表允许相对本地对照下降最多 0.024（量表跨度的 0.6%）；其余质量轴要求均值不下降。所有对照包含随机、v4、v5，v6.32 用于识别 v6.35 新规则是否产生迁移收益。

旧绝对主质量下限在新池的检查：{'通过' if summary['legacyQualityFloorsPassed'] else '未全部通过'}；各轴的 legacyFloorPassed 见 JSON。这与上表相对新池对照的均值检查分开报告。

### 稳定性与解释边界

{ci}

完整池的 20 个种子区间仅反映该池内的算法随机性。另按来源组件的固定散列分为 5 个互不重叠的面板，每面板运行 200–203 四个种子后先取均值，再对面板均值做 10,000 次成对 bootstrap；少于 100 条候选的面板标为不足。面板数最多只有 5 个；拆分后候选池变小、K=100 的采样比例增大，这些区间描述的是小池压力测试，**不是完整池均值差的置信区间**，也不代表总体显著性或已控制多重比较。例如 HelpSteer2 helpfulness 在完整池低于 v4，但小面板平均高于 v4，不能用后者覆盖前者。完整两两对照、标注分母、K 敏感性与所有负面结果见[独立结果](examples/v635-independent-20261013/summary.json)。失败说明当前证据不支持全面泛化，不单凭一次确认失败断言已经证明过拟合；若继续据此调参，本批即转为开发数据，下一次确认须另取来源。

[冻结协议](examples/v635-independent-20261013/protocol.json)、[来源排除清单](examples/v635-independent-20261013/pool-manifest.json)、[独立指标审计](examples/v635-independent-20261013/audited-metrics.json)、[穷举来源隔离验证](examples/v635-independent-20261013/source-isolation-verification.json)与入选 ID 已保存。性能旧门槛保持；本轮运行耗时仅供诊断，不冒充同机隔离资源验收。未接入生产 Worker，未在浏览器中验证新候选。

---

'''
pth=docs/'eight-datasets-comparison-report.md';old=pth.read_text()
if old.startswith('## v6.35 独立来源确认'):old=old[old.index('## 摘要连贯性目标调整（2026-10-13）'):]
pth.write_text(text+old)
print(json.dumps({'runs':summary['methodRuns'],'coverage':[{k:r[k] for k in ['source','v635GainOverV5','matchedGainOverV5','coveragePassed']} for r in summary['coverage']],'quality':[{'source':q['source'],'axis':q['axis'],'means':q['means'],'pointPassed':q['pointPassed'],'panelAndFullPointChecksPassed':q['panelAndFullPointChecksPassed']} for q in summary['quality'] if q['decisionAxis']]},ensure_ascii=False,indent=2))
