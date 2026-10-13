"""Publish the frozen complete-exchange experiment without rewriting earlier evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean
import shutil
import sys

root, docs = map(Path, sys.argv[1:3])
out = docs/'examples'/'budgeted-v64'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'V63', 'REPLAY', 'GAIN', 'V64']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
audit = json.loads((root/'verification.json').read_text())
status = json.loads((root/'test-status.json').read_text())
assert audit['passed'] and audit['datasets'] == 8 and audit['scenarios'] == 77
assert status['focusedPassed'] and status['scriptTypecheckPassed']
assert audit['auditorSha256'] == sha('scripts/trace-datasets/audit-complete-v64.ts')
reports = {n: json.loads((root/f'{n}.json').read_text()) for n in names}
for name, report in reports.items():
    assert report['finishedAt'] and not report['plan']['smoke']
    for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
    with (out/f'{name}.json.gz').open('wb') as handle:
        with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write((root/f'{name}.json').read_bytes())
for file in ['plan.json', 'verification.json', 'test-status.json', 'full-failure-names.json']:
    shutil.copyfile(root/file, out/file)
primary, quality, flat, sizes, sensitivities = [], [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name,stratum=s['stratum'],population=s['population'],k=s['k'],seed=s['seed'],method=m,vocabulary=run['metrics']['vocabulary'],tokens=run['metrics']['tokens'],quality=json.dumps(run['metrics']['quality']),selection_ms=run['selectionMs']))
        if s['k'] == 100: grouped.setdefault((s['stratum'],s['population']),[]).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name,**s))
        if s['k'] == 100 and s['seed'] == 42 and s['population'] == 'all': sensitivities.append(dict(dataset=name,**s))
    for (stratum,population),trials in grouped.items():
        assert sorted(s['seed'] for s in trials) == [42,100,101,102,103]
        eq = [e for e in audit['equalBudget'] if (e['dataset'],e['stratum'],e['population'],e['k']) == (name,stratum,population,100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name,stratum=stratum,population=population,methods={m:{k:mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary','tokens']} for m in methods},equal={m:mean(e[m] for e in eq) for m in methods if m!='REPLAY'},feasible=sum(s['methods']['V64']['optimization']['feasible'] for s in trials),completeSwaps=mean(s['methods']['V64']['optimization']['completeSwaps'] for s in trials),plateauSwaps=mean(s['methods']['V64']['optimization']['plateauSwaps'] for s in trials)))
        for axis in trials[0]['methods']['V64']['metrics']['quality']:
            quality.append(dict(dataset=name,stratum=stratum,population=population,axis=axis,**{m:mean(s['methods'][m]['metrics']['quality'][axis]['mean'] for s in trials) for m in methods}))
def label(r): return r['dataset']+(' / '+r['stratum'] if r['stratum']!='all' else '')
def gain(r,m): return 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
def pct(v): return f'{v:+.2f}%'
def table(headers,rows): return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str,row))+' |' for row in rows])
coverage = [r for r in primary if r['dataset'] in ms and r['population']=='all']
mainq = [r for r in quality if (r['dataset']=='OASST2' and r['population']=='quality-annotated' and r['axis']=='quality') or (r['dataset']=='HelpSteer2' and r['axis']=='helpfulness') or (r['dataset']=='SummarizeFeedback' and r['axis']=='overall')]
gates=[]
for r in coverage:
    target=max(ms[r['dataset']]+5,gain(r,'C')); reasons=[]
    if gain(r,'V64') < target: reasons.append('覆盖不足')
    if r['equal']['V64'] < r['equal']['C']: reasons.append('同 token 低于 v5')
    if r['feasible'] < 5: reasons.append('存在不可行回退')
    gates.append(dict(condition=label(r)+' / 词汇',value=gain(r,'V64'),target=target,passed=not reasons,reason='；'.join(reasons) or '覆盖、同 token 及预算通过'))
for r in mainq:
    target=max(r['B0'],r['B4']) if r['dataset']=='HelpSteer2' else max(r['B0']*1.1,r['C'])
    gates.append(dict(condition=label(r)+' / '+r['axis'],value=r['V64'],target=target,passed=r['V64']>=target,reason='人工评分不足' if r['V64']<target else '人工评分条件通过'))
assert len(gates)==11
summary=dict(status='offline_not_enabled',default='trace-coverage-v4',candidate='trace-coverage-v6.4',primary=primary,quality=quality,gates=gates,passed=sum(g['passed'] for g in gates),independentConfirmation='not_run')
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
with (out/'metrics.csv').open('w',newline='') as h:
    w=csv.DictWriter(h,fieldnames=flat[0]);w.writeheader();w.writerows(flat)
ct=table(['数据集','微软公开','v4 默认','v5','v6.3','v6.4','v6.4 − 微软（百分点）','v6.4 − v6.3（百分点）'],[[r['dataset'],pct(ms[r['dataset']]),*[pct(gain(r,m)) for m in ['B4','C','V63','V64']],f"{gain(r,'V64')-ms[r['dataset']]:+.2f}",f"{gain(r,'V64')-gain(r,'V63'):+.2f}"] for r in coverage])
qt=table(['数据 / 质量轴','随机','v4','v5','v6.3','v6.4','v6.4 − v6.3'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['B0','B4','C','V63','V64']],f"{r['V64']-r['V63']:+.3f}"] for r in mainq])
gt=table(['条件','v6.4 实测','原目标下限','结果'],[[g['condition'],f"{g['value']:.3f}",f"{g['target']:.3f}",('通过：' if g['passed'] else '未通过：')+g['reason']] for g in gates])
at=table(['数据及分层','v6.3 覆盖增幅','GAIN 覆盖增幅','v6.4 覆盖增幅','同 token：v6.4 对 v5','同 token：v6.4 对 v6.3','平均替换 / 零收益节省次数'],[[label(r),*[pct(gain(r,m)) for m in ['V63','GAIN','V64']],pct(100*(r['equal']['V64']/r['equal']['C']-1)),pct(100*(r['equal']['V64']/r['equal']['V63']-1)),f"{r['completeSwaps']:.1f} / {r['plateauSwaps']:.1f}"] for r in primary if r['population']=='all'])
qa=table(['数据 / 质量轴','v6.3','GAIN','v6.4'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['V63','GAIN','V64']]] for r in mainq])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
qtg=table(['防退步质量轴','随机','v4','v5','v6.3','v6.4'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['B0','B4','C','V63','V64']]] for r in guards])
st=table(['数据及分层','K（seed=42）','v6.3 覆盖增幅','v6.4 覆盖增幅','可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in ['V63','V64']],s['methods']['V64']['optimization']['feasible']] for s in sizes])
bt=table(['数据及分层','预算倍率','v6.4 覆盖增幅','token / B_ref','可行'],[[label(s),ratio,pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)),f"{s['methods'][m]['metrics']['tokens']/s['methods'][m]['optimization']['baseTokens']:.3f}×",s['methods'][m]['optimization']['feasible']] for s in sensitivities for ratio,m in [(1,'V64_1'),(1.1,'V64'),(1.2,'V64_1.2')]])
perf=[]
for suffix,scenario in [('', 'N=10k 短输入'),('long-','N=1k 长输入')]:
    runs={v:json.loads((root/f'performance-{suffix}{v}.json').read_text()) for v in ['v5','v63','v64']}
    assert runs['v5']['hardware']==runs['v63']['hardware']==runs['v64']['hardware']
    for v,run in runs.items():
        for file,digest in run['codeHashes'].items(): assert sha(file)==digest
        shutil.copyfile(root/f'performance-{suffix}{v}.json',out/f'performance-{suffix}{v}.json')
    for i in range(3):
        measurements={v:r['measurements'][i] for v,r in runs.items()}
        time_ratio=measurements['v64']['selectionMs']/measurements['v5']['selectionMs']
        memory_ratio=measurements['v64']['additionalHighWaterKiB']/max(1,measurements['v5']['additionalHighWaterKiB'])
        perf.append(dict(scenario=scenario,k=measurements['v5']['k'],runs=measurements,ratioToV5=time_ratio,highWaterRatioToV5=memory_ratio,timeGate=time_ratio<=3,highWaterGate=memory_ratio<=1.5))
(out/'performance-summary.json').write_text(json.dumps(perf,indent=2))
pt=table(['场景','K','v5','v6.3','v6.4','v6.4 / v5','3 倍耗时门槛'],[[p['scenario'],p['k'],*[f"{p['runs'][v]['selectionMs']/1000:.3f}s" for v in ['v5','v63','v64']],f"{p['ratioToV5']:.2f}×",'通过' if p['timeGate'] else '未通过'] for p in perf])
mt=table(['场景','K','v5 / v6.3 / v6.4 峰值 RSS MiB','对应高水位增量 MiB','增量 1.5 倍门槛（代理）'],[[p['scenario'],p['k'],' / '.join(f"{p['runs'][v]['maxRssKiB']/1024:.1f}" for v in ['v5','v63','v64']),' / '.join(f"{p['runs'][v]['additionalHighWaterKiB']/1024:.1f}" for v in ['v5','v63','v64']),'通过' if p['highWaterGate'] else '未通过'] for p in perf])
real_perf=[]
for name in names:
    runs={v:json.loads((root/f'performance-real-{name}-{v}.json').read_text()) for v in ['v5','v63','v64']}
    assert runs['v5']['hardware']==runs['v63']['hardware']==runs['v64']['hardware']
    for v,run in runs.items():
        assert run['sourceSha256']==reports[name]['dataSha256'] and run['resultsSha256']==sha(root/f'{name}.json')
        for file,digest in run['codeHashes'].items(): assert sha(file)==digest
        shutil.copyfile(root/f'performance-real-{name}-{v}.json',out/f'performance-real-{name}-{v}.json')
    for i in range(len(runs['v5']['measurements'])):
        m={v:r['measurements'][i] for v,r in runs.items()}
        assert len({x['stratum'] for x in m.values()})==1 and all(x['idsMatchFrozen'] for x in m.values())
        ratio=m['v64']['selectionMs']/m['v5']['selectionMs']
        memory=m['v64']['additionalHighWaterKiB']/m['v5']['additionalHighWaterKiB'] if m['v5']['additionalHighWaterKiB'] and m['v64']['additionalHighWaterKiB'] else None
        real_perf.append(dict(dataset=name,stratum=m['v5']['stratum'],runs=m,ratioToV5=ratio,timeGate=ratio<=3,highWaterRatioToV5=memory,highWaterGate=memory<=1.5 if memory is not None else None))
(out/'performance-real-summary.json').write_text(json.dumps(real_perf,indent=2))
rt=table(['实际数据 / K=100 / seed=42','v5','v6.3','v6.4','v6.4 / v5','3 倍耗时门槛'],[[label(r),*[f"{r['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v63','v64']],f"{r['ratioToV5']:.2f}×",'通过' if r['timeGate'] else '未通过'] for r in real_perf])
rmt=table(['实际数据','v5 / v6.3 / v6.4 峰值 RSS MiB','对应高水位增量 MiB','1.5 倍增量门槛（代理）'],[[label(r),' / '.join(f"{r['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5','v63','v64']),' / '.join(f"{r['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5','v63','v64']),'数据不足' if r['highWaterGate'] is None else '通过' if r['highWaterGate'] else '未通过'] for r in real_perf])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,ax=plt.subplots(figsize=(14,8),layout='constrained'); y=np.arange(6)
for offset,m,color,name in [(-.27,'MS','#b45309','Microsoft (published)'),(-.09,'C','#4f46e5','v5'),(.09,'V63','#0f766e','v6.3'),(.27,'V64','#0369a1','v6.4 (offline)')]:
    values=[ms[r['dataset']] if m=='MS' else gain(r,m) for r in coverage]
    bars=ax.barh(y+offset,values,height=.17,color=color,label=name)
    ax.bar_label(bars,labels=[f'{v:+.2f}%' for v in values],padding=3,fontsize=8)
ax.set_yticks(y,[r['dataset'] for r in coverage]);ax.invert_yaxis();ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True);ax.margins(x=.15)
ax.set_xlabel('Distinct input vocabulary uplift over each random baseline (%)');ax.set_title('Microsoft vs v5 / v6.3 / v6.4\nDifferent Microsoft pool/protocol: numerical targets, not a head-to-head comparison');ax.legend(loc='lower right',fontsize=8)
fig.savefig(out/'comparison.png',dpi=170);fig.savefig(out/'comparison.svg',metadata={'Date':None});plt.close(fig)
validation=table(['验证项','结果'],[['采样与 SQLite/Worker 专项',f"{status['focused']['pass']}/{status['focused']['tests']} 通过；其中新增 8 项 v6.4 测试"],['采样器、研究脚本、测试严格类型检查','通过'],['全仓 npm run test',f"{status['fullSuite']['pass']} 通过，{status['fullSuite']['fail']} 失败，{status['fullSuite']['skipped']} 跳过"],['全仓类型检查','通过' if status['typecheckPassed'] else '未通过；具体错误见验证记录'],['新版 Web UI / 四 Worker 压力 / 新来源确认','未执行；新候选未接入生产']])
text=f'''<!-- V64-REPORT-START -->
## v6.4：补全替换搜索，并允许等覆盖节省成本

**默认仍为 v4；v6.4 为离线候选。原有 11 项主要效果条件通过 {summary['passed']} 项（v6.3 为 1 项），整体目标未完成。** 以下同时展示改善、退步与成本，保留全部原门槛。本轮没有使用 LLM、人工评分选样、数据源专用规则或新增生产存储。

六源原始覆盖均较 v6.3 提高，WildChat/Dolly 的同 token 退步恢复，UltraChat 以很小余量达到原覆盖目标；OASST2、HelpSteer2 和 CNN-DM 的人工质量下降。真实池独立进程测量有 {len(real_perf)-sum(r['timeGate'] for r in real_perf)}/{len(real_perf)} 个分层未通过 3 倍耗时门槛，完整搜索的开销不能忽略；本轮仍不满足整体放行要求。

### 微软与本地版本直接对照

{ct}

“v6.4 − 微软”直接显示相对微软公开增幅的差距；它只比较词汇量。原验收要求还包括超过微软公开值 5 个百分点、不低于 v5、同 token 覆盖及预算/分布约束。后面的 11 行验收表将这六行逐项补上这些条件，再加入五行人工质量条件；两个表不是两套互相替代的效果结论。

微软参照来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。本地为冻结池 K=100、五种子均值。双方池、分词和协议不同，公开数值目标通过不等于严格优于微软算法。

![微软与本地采样效果对照](examples/budgeted-v64/comparison.png)

### 人工质量与逐项验收

{qt}

{gt}

前六项使用覆盖百分数，后五项使用原量纲评分。HelpSteer2 门槛取随机和 v4 的较高值；OASST2 及三个摘要分层取随机的 1.10 倍和 v5 的较高值。质量标签仅在选样完成后评估，不进入优化器。人工质量未全部通过时不能启用新版。

### 改了什么，收益来自哪里

旧搜索只检查按新增词汇、效率或移除损失排列的短名单，可能漏掉与某个被替换样本高度重叠、但总体新增词数不高的输入。新搜索在原有回答变体与路径选择规则下，扫描全部未选输入对全部已选问答的一换一组合。

对每个已选词项记录唯一归属，替换的准确净收益为 `新增未覆盖词数 − 被替换项独占词数 + 新项收回的独占词数`。完整检验预算、TV、任务及真实路径保底后，先选净收益最大的替换，同收益时选更省 token 的替换，最后按稳定键。允许零净收益且成本严格减少的步骤，为后续增加覆盖腾出预算；拒绝负收益及零收益等成本步骤。最多 min(64,K) 轮，并在扫描中让出执行权。只有覆盖达到有效上界且成本也达到下界时，完整策略才可据此提前结束；不将单步局部最优称为全局最优。

- **REPLAY**：关闭新搜索，全部 {audit['scenarios']} 个场景精确回放 v6.3 ID。
- **GAIN**：完整搜索，但只允许正覆盖收益。
- **v6.4**：完整搜索，也允许等覆盖节省。相对可行 v6.3 保证原始覆盖不减少；人工质量及同 token 覆盖仍需实测。

{at}

{qa}

同 token 统一使用 `min(B0,B4,C,V6,V61,V62,V63,V64)` 的输入词法 token 总量，按既有固定散列顺序读入，最后一个输入只在计量时截断；GAIN 使用同一截止点。未改写入选内容，计量排序、截止点、来源名称和人工标签都不输入采样器。

### 质量防退步轴

{qtg}

这些轴同样保留；不能以 helpfulness 或 overall 单轴变化掩盖 correctness、accuracy、coverage 或 coherence 的下降。当前五种子均值是开发回归证据，不构成独立来源的非劣性结论。

### 生成数量与预算敏感性

{st}

{bt}

主验收仍使用 1.10 倍预算；1.20 倍只用于诊断，不能替代主结果。所有冻结场景、消融和预算敏感性均保留入选 ID 与原始指标。

### 性能与验证边界

{pt}

{mt}

三个版本在同机串行、独立进程运行。RSS 增量相对特征准备后的高水位，且 K 顺序累计，属于代理测量；单次测量受后台服务影响，不是精确内存分配，也不是四 Worker 并发证据。合成池常可利用覆盖上界提前结束，不能代表真实池中的完整搜索成本。

{rt}

{rmt}

实际数据另行串行复测，每个数据源和版本单独启动进程，固定 K=100、seed=42，并校验全部入选 ID 与主实验一致。摘要的三个分层共用进程；签名从带校验和的临时研究缓存读入，准备耗时单列。实际数据 {len(real_perf)} 个分层中仅 {sum(r['timeGate'] for r in real_perf)} 个通过 3 倍选样耗时门槛，因此整体性能尚未通过。RSS 是高水位代理；增量为零仅表示未超过准备阶段峰值，不等于零分配，对应门槛标为数据不足。它不代替完整 Worker 压力；实际池的完整搜索不能用合成池的上界提前结束计时来代表。主比较程序中受其他测试影响的计时仍保留在原始结果，但不用于这张性能判定表。

{validation}

[验证记录](examples/budgeted-v64/test-status.json)保留完整测试统计；全仓失败项名称见[失败列表](examples/budgeted-v64/full-failure-names.json)，不将未逐项定位的失败全部归因于环境或既有问题。本轮未在浏览器中验证 v6.4；已有 v4 Web UI 证据不能替代新版验收。

独立指标审计从原文重算 {audit['selectedItems']:,} 条入选记录、{audit['qualityMeans']:,} 个质量均值及预算/TV/上界；所有旧代码与旧证据保留。当前池已参与开发，尚无新来源确认，也缺少微软同池实现对照。性能、质量和完整验证未达要求之前，生产 Worker 仍仅分派 v4/v5。

证据：[汇总](examples/budgeted-v64/summary.json) · [逐场景 CSV](examples/budgeted-v64/metrics.csv) · [独立审计](examples/budgeted-v64/verification.json) · [实验协议](examples/budgeted-v64/plan.json) · [合成性能](examples/budgeted-v64/performance-summary.json) · [实际数据性能](examples/budgeted-v64/performance-real-summary.json)。上轮的覆盖上界与证书仍在后文保留，其高于目标不能证明可行性或质量可达。

<!-- V64-REPORT-END -->

'''
report=docs/'eight-datasets-comparison-report.md'
old=report.read_text()
if '<!-- V64-REPORT-START -->' in old:
    assert old.startswith('<!-- V64-REPORT-START -->')
    old=old.split('<!-- V64-REPORT-END -->\n\n',1)[1]
report.write_text(text+old)
files=['src/lib/trace-datasets/sampling/budgeted-complete.ts','scripts/trace-datasets/compare-complete-v64.ts','scripts/trace-datasets/audit-complete-v64.ts','scripts/trace-datasets/benchmark-complete.ts','scripts/trace-datasets/benchmark-complete-real.ts','scripts/trace-datasets/report-complete-v64.py','test/trace-datasets-budgeted-complete.test.ts']
(out/'implementation.json').write_text(json.dumps({p:sha(p) for p in files},indent=2))
print(json.dumps(dict(passed=summary['passed'],mainConditions=len(gates),report=str(report)),ensure_ascii=False))
