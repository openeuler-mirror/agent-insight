"""Publish six frozen rounds, including unsuccessful gates and earlier evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean, median
import shutil
import sys

root, docs = map(Path, sys.argv[1:3])
out = docs/'examples'/'evidence-six-rounds-v632-v637'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {f'V6{n}':f'v6{n}' for n in range(32,38)}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0','B4','C','V630','V631',*rounds]
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-evidence-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V637': reports[name] = report
    for file in ['plan.json', 'verification.json']: shutil.copyfile(current/file, target/file)
primary, quality, flat, sizes, sensitivities = [], [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], k=s['k'], seed=s['seed'], method=m, vocabulary=run['metrics']['vocabulary'], tokens=run['metrics']['tokens'], quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs']))
        if s['k'] == 100: grouped.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name, **s))
        if s['k'] == 100 and s['seed'] == 42 and s['population'] == 'all': sensitivities.append(dict(dataset=name, **s))
    for (stratum, population), trials in grouped.items():
        assert sorted(s['seed'] for s in trials) == [42, 100, 101, 102, 103]
        eq = [e for e in audits['V637']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, diagnostics={m:{'replacements':mean(s['methods'][m].get('evidence',{}).get('replacements',0) for s in trials),'swaps':mean(s['methods'][m].get('evidenceSearch',{}).get('swaps',0) for s in trials)} for m in rounds}))
        for axis in trials[0]['methods']['V637']['metrics']['quality']:
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **{m: mean(s['methods'][m]['metrics']['quality'][axis]['mean'] for s in trials) for m in methods}))
gain = lambda r, m: 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
coverage = [r for r in primary if r['dataset'] in ms and r['population'] == 'all']
mainq = [r for r in quality if (r['dataset'] == 'OASST2' and r['population'] == 'quality-annotated' and r['axis'] == 'quality') or (r['dataset'] == 'HelpSteer2' and r['axis'] == 'helpfulness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] == 'overall')]
gates = {}
for m in rounds:
    gates[m] = []
    for r in coverage:
        target = max(ms[r['dataset']]+5, gain(r, 'C')); reasons = []
        if gain(r, m) < target: reasons.append('原始覆盖不足')
        eq = [e for e in audits[m]['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (r['dataset'], r['stratum'], r['population'], 100)]
        if mean(e[m] for e in eq) < mean(e['C'] for e in eq): reasons.append('同 token 低于 v5')
        if r['feasible'][m] < 5: reasons.append('不可行回退')
        gates[m].append(dict(condition=label(r)+' / 词汇', value=gain(r, m), target=target, passed=not reasons, reason='；'.join(reasons) or '通过'))
    for r in mainq:
        target = max(r['B0'], r['B4']) if r['dataset'] == 'HelpSteer2' else max(r['B0']*1.1, r['C'])
        gates[m].append(dict(condition=label(r)+' / '+r['axis'], value=r[m], target=target, passed=r[m] >= target, reason='通过' if r[m] >= target else '人工评分不足'))
    assert len(gates[m]) == 11
quality_changes = json.loads((root/'quality-changes.json').read_text())
assert quality_changes['postSelectionOnly'] and quality_changes['scriptSha256'] == sha('scripts/trace-datasets/explain-evidence-quality.ts')
for source in quality_changes['sources']:
    assert source['resultsSha256'] == sha(root/'v637'/(source['dataset']+'.json'))
    assert source['dataSha256'] == reports[source['dataset']]['dataSha256']
shutil.copyfile(root/'quality-changes.json',out/'quality-changes.json')
change_table=table(['人工质量轴','步骤','同输入换回答 / 换输入（次）','评分上升 / 下降 / 持平','缺少可比评分','总体均分变化'],[[label(r)+' / '+r['axis'],r['from'].replace('V6','v6.')+' → '+r['to'].replace('V6','v6.'),f"{r['answerChanges']} / {r['inputChanges']}",f"{r['improved']} / {r['worsened']} / {r['equal']}",r['notComparable'],f"{r['observedMeanDelta']:+.4f}"] for r in quality_changes['rows']])
status = json.loads((root/'test-status.json').read_text())
assert status['focusedPassed'] and status['scriptTypecheckPassed']
support=json.loads((root/'support-verification.json').read_text());assert support['passed'] and support['scenarios']==99 and support['scriptSha256']==sha('scripts/trace-datasets/verify-evidence-support.ts')
for item in support['sources']:
    assert item['resultsSha256']==sha(root/'v637'/(item['dataset']+'.json')) and item['dataSha256']==reports[item['dataset']]['dataSha256']
for file in ['test-status.json', 'full-failure-names.json', 'audit-negative-controls.json', 'support-verification.json']: shutil.copyfile(root/file, out/file)
perf = []
for name in names:
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5','v630',*[m.lower() for m in rounds]]}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v637'/f'{name}.json')
        assert run['hardware'] == runs['v5']['hardware']
        shutil.copyfile(root/'performance-final'/f'{name}-{v}.json', out/f'performance-{name}-{v}.json')
    for i in range(len(runs['v5']['measurements'])):
        selected = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['idsMatchFrozen'] for r in selected.values())
        ratios = {m: selected[m.lower()]['selectionMs']/selected['v5']['selectionMs'] for m in rounds}
        memory = {m: selected[m.lower()]['additionalHighWaterKiB']/selected['v5']['additionalHighWaterKiB'] if selected[m.lower()]['additionalHighWaterKiB'] and selected['v5']['additionalHighWaterKiB'] else None for m in rounds}
        perf.append(dict(dataset=name, stratum=selected['v5']['stratum'], runs=selected, ratios=ratios, memoryRatios=memory))
synthetic = []
for long in [False, True]:
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5',*[m.lower() for m in rounds]]}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['cacheKey'] == runs['v5']['cacheKey']
        shutil.copyfile(root/'performance-final'/f'synthetic-{long}-{v}.json', out/f'synthetic-{long}-{v}.json')
    for i in range(3):
        measurements = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['count'] == r['k'] for r in measurements.values())
        synthetic.append(dict(scenario='N1k 长输入' if long else 'N10k 短输入', k=measurements['v5']['k'], runs=measurements, ratios={m: measurements[m.lower()]['selectionMs']/measurements['v5']['selectionMs'] for m in rounds}))
best_quality=[dict(condition=label(r)+' / '+r['axis'],method=max(rounds,key=lambda m:r[m]),value=max(r[m] for m in rounds),target=gates['V637'][6+i]['target']) for i,r in enumerate(mainq)]
summary = dict(bestByMainQuality=best_quality,status='offline_not_enabled', default='trace-coverage-v4', roundsCompleted=6, earlyStopped=False, primary=primary, quality=quality, gates=gates, passed={m: sum(g['passed'] for g in gs) for m, gs in gates.items()}, performance=perf, synthetic=synthetic, independentConfirmation='not_run', browserValidated=False, qualityChanges=[{k:v for k,v in r.items() if k!='cases'} for r in quality_changes['rows']])
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    writer = csv.DictWriter(h, fieldnames=flat[0]); writer.writeheader(); writer.writerows(flat)
titles=['成对交集精确复用','短语共识替换回答','短语分数保覆盖交换','重复片段校准（独立分支）','重复片段分数保覆盖交换','双信号共同支持（独立分支）']
round_table=table(['轮次','调整','主要条件','耗时 ≤3×v5（真实池）'],[[m.replace('V6','v6.'),title,f"{summary['passed'][m]}/11",f"{sum(p['ratios'][m]<=3 for p in perf)}/10"] for m,title in zip(rounds,titles)])
ct=table(['数据集','微软公开','v5','起点 v6.30','最终 v6.37','v6.37−微软（百分点）','原目标','距目标（百分点）'],[[r['dataset'],pct(ms[r['dataset']]),pct(gain(r,'C')),pct(gain(r,'V630')),pct(gain(r,'V637')),f"{gain(r,'V637')-ms[r['dataset']]:+.2f}",pct(max(ms[r['dataset']]+5,gain(r,'C'))),f"{gain(r,'V637')-max(ms[r['dataset']]+5,gain(r,'C')):+.2f}"] for r in coverage])
qt=table(['人工质量轴','随机','上一批 v6.31','起点 v6.30',*[m.replace('V6','v6.') for m in rounds],'原目标'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','V631','V630',*rounds]],f"{gates['V637'][6+i]['target']:.4f}"] for i,r in enumerate(mainq)])
gt=table(['原条件','目标',*[m.replace('V6','v6.') for m in rounds]],[[g['condition'],f"{g['target']:.4f}",*[f"{gates[m][i]['value']:.4f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds]] for i,g in enumerate(gates['V637'])])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['质量防退步轴','随机','v4','起点 v6.30',*[m.replace('V6','v6.') for m in rounds]],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','B4','V630',*rounds]]] for r in guards])
pt=table(['真实池 / K100 seed42','v5','起点 v6.30',*[m.replace('V6','v6.') for m in rounds],'v6.37 / v5'],[[label(p),*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v630',*[m.lower() for m in rounds]]],f"{p['ratios']['V637']:.2f}×"] for p in perf])
mt=table(['真实池','v5 / v6.32 / v6.37 峰值 RSS MiB','对应高水位增量 MiB','v6.37 增量 ≤1.5×v5'],[[label(p),' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5','v632','v637']),' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5','v632','v637']),'数据不足' if p['memoryRatios']['V637'] is None else '通过' if p['memoryRatios']['V637']<=1.5 else '未通过'] for p in perf])
st=table(['合成场景','K','v5',*[m.replace('V6','v6.') for m in rounds]],[[p['scenario'],p['k'],*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5',*[m.lower() for m in rounds]]]] for p in synthetic])
et=table(['数据及分层',*[m.replace('V6','v6.')+' 同 token 相对 v5' for m in rounds]],[[label(r),*[pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds]] for r in primary if r['population']=='all'])
size_table=table(['数据及分层','K / seed42',*[m.replace('V6','v6.') for m in rounds],'六轮均可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table=table(['数据及分层','预算',*[m.replace('V6','v6.') for m in rounds],'六轮均可行'],[[label(s),ratio,*[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio,suffix in [(1,'_1'),(1.1,''),(1.2,'_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,axes=plt.subplots(1,2,figsize=(16,7),layout='constrained');y=np.arange(6)
for offset,values,color,title in [(-.22,[ms[r['dataset']] for r in coverage],'#b45309','Microsoft published'),(0,[gain(r,'V630') for r in coverage],'#64748b','v6.30 baseline'),(.22,[gain(r,'V637') for r in coverage],'#0369a1','v6.37')]:
 bars=axes[0].barh(y+offset,values,height=.2,color=color,label=title);axes[0].bar_label(bars,fmt='%.1f',padding=3,fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5,gain(r,'C')) for r in coverage],y,marker='|',s=220,color='#dc2626',label='Original target');axes[0].set_yticks(y,[r['dataset'] for r in coverage]);axes[0].invert_yaxis();axes[0].set_xlabel('Vocabulary uplift over random (%)');axes[0].set_title('Coverage vs public numerical targets\nMicrosoft uses a different pool/protocol');axes[0].legend(fontsize=8,loc='lower right');axes[0].margins(x=.15)
x=np.arange(6)
for i,r in enumerate(mainq):
 values=[100*r[m]/gates['V637'][6+i]['target'] for m in rounds];axes[1].plot(x,values,marker='o',label=['OASST2 quality','HelpSteer2 helpfulness','CNN-DM overall','TLDR valid2 overall','TLDR valid1 overall'][i]);axes[1].annotate(f'{values[-1]:.1f}%',(x[-1],values[-1]),xytext=(6,-8 if i==0 else 1 if i==1 else 0),textcoords='offset points',fontsize=8)
axes[1].axhline(100,color='#dc2626',linestyle='--',label='Original target');axes[1].set_xticks(x,[m.replace('V6','v6.') for m in rounds]);axes[1].set_xlim(-.2,5.8);axes[1].set_ylim(min(94,min(100*r[m]/gates['V637'][6+i]['target'] for i,r in enumerate(mainq) for m in rounds)-1),max(113,max(100*r[m]/gates['V637'][6+i]['target'] for i,r in enumerate(mainq) for m in rounds)+1));axes[1].set_ylabel('Human quality / original target (%)');axes[1].set_title('All six rounds: human quality\nv6.35 / v6.37 branch from v6.32; five frozen seeds');axes[1].legend(fontsize=8,loc='upper center',bbox_to_anchor=(.5,-.07),ncol=2)
for ax in axes:ax.grid(alpha=.2);ax.set_axisbelow(True)
fig.savefig(out/'comparison.png',dpi=170);fig.savefig(out/'comparison.svg',metadata={'Date':None});plt.close(fig)
old_gates=json.loads((docs/'examples/calibrated-six-rounds-v626-v631/summary.json').read_text())['gates']['V631']
new_passes=[g['condition'] for i,g in enumerate(gates['V637']) if g['passed'] and not old_gates[i]['passed']];lost_passes=[g['condition'] for i,g in enumerate(gates['V637']) if not g['passed'] and old_gates[i]['passed']]
failures='、'.join(g['condition'] for g in gates['V637'] if not g['passed'])
quality_delta=table(['质量轴','v6.37−本批起点 v6.30','v6.37−上批 v6.31'],[[label(r)+' / '+r['axis'],f"{r['V637']-r['V630']:+.4f}",f"{r['V637']-r['V631']:+.4f}"] for r in mainq])
text=f'''<!-- EVIDENCE-SIX-ROUNDS-REPORT-START -->
## 本次六轮优化：v6.32—v6.37

**六轮均已完成，共 594 次新候选运行，未提前停止，整体目标仍未达成。** 原要求不变，主要条件依次为 {' → '.join(str(summary['passed'][m])+'/11' for m in rounds)}；默认继续 v4。最终未通过主条件：{failures or '无'}。质量防退步、资源、独立确认与完整 Worker/UI 是额外条件，不用主效果通过数代替。

{round_table}

本批从 v6.30 分支继续；v6.35 和 v6.37 均从 v6.32 独立分支，分别检验重复片段校准和双信号共同支持。相对上一批 v6.31，最终新增通过项：{'、'.join(new_passes) or '无'}；失去通过项：{'、'.join(lost_passes) or '无'}。下面同时列出本批起点与上一批，撤回旧改动带来的恢复不计为新规则收益。

### 与微软公开数值直接对照

{ct}

微软冻结参照来自[公开实验报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。双方数据池与协议不同，此处比较公开数值，不能声称同池算法胜负。原目标仍为 max(微软增幅+5 个百分点, v5 增幅)，同时检查同 token、预算和分布。

![六轮采样与原目标比较](examples/evidence-six-rounds-v632-v637/comparison.png)

### 人工质量和全部主要条件

{qt}

{quality_delta}

两个质量难点在本批内的最好单项值分别为：{'；'.join(f"{b['condition']} {b['value']:.5f}（{b['method'].replace('V6','v6.')}，目标 {b['target']:.5f}）" for b in best_quality[:2])}。这些是单项极值，不能拼接为已经验证通过的统一策略，也不能预设最后一轮就是最好。每次实际替换及人工评分变化列于后文。

本批最明确的收益来自 v6.35：在 OASST2 的 K100 五种子中替换 16 次回答，9 次人工评分提高、4 次下降、3 次持平，quality 净增 0.00233；HelpSteer2 没有换回答，质量保持。v6.34 的一次 HelpSteer2 换输入反而使 helpfulness 下降 0.004。v6.37 在这两个质量难点的 K100 五种子上均未改变样本，因而没有产生收益；“两个代理都支持”限制了替换，但不等于找到了更高质量样本。

上述六项覆盖、五项质量和下表为同一批 K100 五种子结果。OASST2 覆盖取 all 池，质量取 quality-annotated 子池；HelpSteer2 要求至少达到随机与 v4，其他四项质量要求至少达到随机的 1.10 倍及 v5。质量标签只在返回 ID 后读取。

{gt}

质量防退步轴逐项保留，其他评分轴也全部存于原始 JSON：

{guard_table}

独立确认尚未运行，此处只报告开发池的全部点估计，不作统计非劣结论；不得因 overall 通过而忽略其他轴下降。五个没有人工评分的数据源仍缺少直接质量证据。

### 六轮方案及变化定位

1. **v6.32** 在 v6.30 完整流程中，缓存不同大小词项集合的双向交集加权和；相同大小仍按原方向求和，保留浮点顺序。缓存仅在本次输入组内存在。全部 99 场景精确回放旧有序 ID、路径、原因及诊断，版本名除外。
2. **v6.33** 使用词法相邻 token 的不同二元组，按去重回答顺序最多取 32 个支持，P 为平均 F2=5×交集/(4×支持集合大小+当前集合大小)，零分母为零。分数为 0.80×原长度校准分数+0.20×P，仅换同输入可行回答；单回答或全组无二元组时沿用旧分数。
3. **v6.34** 按短语分数最多 min(16,K) 次一换一，保留起点覆盖、数量、独立输入数、预算/TV、任务及真实路径。
4. **v6.35** 从 v6.32 独立出发，D=不同二元组数/出现次数（少于两个 token 为零），分数为 0.90×原长度校准分数+0.10×D，仅换同输入可行回答。单回答或全组无二元组沿用旧分数。
5. **v6.36** 按重复片段分数执行相同的保覆盖交换。
6. **v6.37** 从 v6.32 独立出发，采用第 2、4 轮分数均值；先换同输入回答，再最多 min(16,K) 次交换。每次要求两种分数都不降低且均值严格提高，并保持全部可行性条件。该约束不保证人工质量。

这些都是可复算的词项/长度信号，不是语义、事实或有用性判断，也不用于过滤候选。没有 LLM、人工标签选样、来源特判、新 Trace 字段或生产特征存储。

{change_table}

变化定位是采样后的人工评分关联，跨五个种子累计替换次数，可能重复涉及同一条原始记录；缺少可比评分另列，不算持平，总体均分仍用原标注分母。记录每次替换的 ID 与原始评分，不能把代理分数增加解释为人工质量提高。见[逐次质量变化](examples/evidence-six-rounds-v632-v637/quality-changes.json)。

### 同 token、性能与内存

{et}

同 token 仍按原 QA ID 散列顺序取共同最小预算，另存固定 v6.4 预算。只换回答也可能改变此排序；没有用计量散列选样。

{pt}

真实池 K100/seed42 同机串行，每个数据源/方法使用独立进程，摘要三分层在相应进程内测量；计入全部回答计算，输入 MinHash 采用带校验和临时缓存，准备时间另列。全部 ID 与主实验核对。v6.32 相对 v6.30 耗时比值中位变化 {pct(100*(median(p['runs']['v632']['selectionMs']/p['runs']['v630']['selectionMs'] for p in perf)-1))}；最终相对 v5 的 3 倍耗时门槛通过 {sum(p['ratios']['V637']<=3 for p in perf)}/10。单次测量受 GC 和同机活动影响，不代表稳定加速比，不是生产端到端耗时。

{mt}

高水位差只是增量 RSS 代理，零分母/零增量写“数据不足”，不算通过。完整四 Worker 资源验证仍未完成。

{st}

### 数量、预算敏感性与验证

沿用原八源固定池，K100 种子 42/100/101/102/103，seed42 的 K20/K500 与预算 1.00/1.10/1.20。每轮 77 个主场景加 22 个预算敏感性，以下列 all 池，有标注子池同样保留全部原始结果。

{size_table}

{budget_table}

六轮审计分别从原文独立复算本轮指标、全部人工质量、预算、TV 和上界；历史方法逐字段校验与上一轮已审计结果一致，计时来源标注除外，并保存上一轮审计 SHA。相同预算可复用历史已审计的同 token 值，预算变化则重算。新轮全部 99 场景均检查数量、去重、实际路径和各分支不变量；历史方法不冒充新增运行。另从原文独立重算第六轮两种分数，99 场景逐位置检查相对 v6.32 两项均不下降、发生变化时均值严格提高，见[双信号验证](examples/evidence-six-rounds-v632-v637/support-verification.json)。两项反向验证分别篡改当前 token 指标和历史样本 ID，审计均正确拒绝，见[反向验证记录](examples/evidence-six-rounds-v632-v637/audit-negative-controls.json)。

新增 8 项算法测试，专项 {status['focused']['pass']}/{status['focused']['tests']} 通过，新代码严格类型检查通过。全仓 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过；相对上批新增 {len(status['newFailureNames'])} 个失败节点、消失 {len(status['resolvedFailureNames'])} 个。原始全量统计不被隔离复测覆盖。

{status.get('failureReview','')}

原开发池已反复使用，不是新来源独立确认。生产 Worker 与默认 v4 保持；**本次未在浏览器中验证新候选**，旧 UI 证据不代替新版。六轮结束，不追加第七轮。

证据：[汇总](examples/evidence-six-rounds-v632-v637/summary.json)、[逐场景指标](examples/evidence-six-rounds-v632-v637/metrics.csv)、[源码哈希](examples/evidence-six-rounds-v632-v637/implementation.json)、[测试记录](examples/evidence-six-rounds-v632-v637/test-status.json)、[全量失败名称](examples/evidence-six-rounds-v632-v637/full-failure-names.json)、[证据校验](examples/evidence-six-rounds-v632-v637/report-verification.json)。同目录保留 48 份原始压缩结果、6 份计划与审计、64 份真实池及 14 份合成性能记录；以下历史报告原样保留。

<!-- EVIDENCE-SIX-ROUNDS-REPORT-END -->

'''
report=docs/'eight-datasets-comparison-report.md';old=report.read_text()
if old.startswith('<!-- EVIDENCE-SIX-ROUNDS-REPORT-START -->'):old=old.split('<!-- EVIDENCE-SIX-ROUNDS-REPORT-END -->\n\n',1)[1]
report.write_text(text+old)
files=['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['answer-memo-paired','budgeted-memo-base','budgeted-supported-proxy','answer-phrase','budgeted-evidence']]+['scripts/trace-datasets/'+n for n in ['compare-evidence-rounds.ts','audit-evidence-rounds.ts','benchmark-evidence-rounds.ts','benchmark-evidence-rounds-synthetic.ts','report-evidence-rounds.py','explain-evidence-quality.ts','verify-evidence-support.ts']]+['test/trace-datasets-evidence.test.ts']
(out/'implementation.json').write_text(json.dumps({f:sha(f) for f in files},indent=2))
print(json.dumps({'rounds':6,'passed':summary['passed'],'report':str(report)},ensure_ascii=False))
