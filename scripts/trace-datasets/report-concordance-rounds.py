"""Publish three frozen rounds, including unsuccessful gates and earlier evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean, median
import shutil
import sys

root, docs = map(Path, sys.argv[1:3])
out = docs/'examples'/'concordance-three-rounds-v623-v625'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V623': 'v623', 'V624': 'v624', 'V625': 'v625'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V619', 'V622', 'V623', 'V624', 'V625']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-concordance-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V625': reports[name] = report
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
        eq = [e for e in audits['V625']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, concordanceReplacements=mean(s['methods']['V624']['concordance']['replacements'] for s in trials), concordanceSwaps=mean(s['methods']['V625']['concordanceSearch']['swaps'] for s in trials), concordanceGain=mean((s['methods']['V625']['concordanceSearch']['finalScore'] or 0)-(s['methods']['V625']['concordanceSearch']['initialScore'] or 0) for s in trials)))
        for axis in trials[0]['methods']['V625']['metrics']['quality']:
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
assert quality_changes['postSelectionOnly'] and quality_changes['scriptSha256'] == sha('scripts/trace-datasets/explain-concordance-quality.ts')
for source in quality_changes['sources']:
    assert source['resultsSha256'] == sha(root/'v625'/(source['dataset']+'.json'))
    assert source['dataSha256'] == reports[source['dataset']]['dataSha256']
shutil.copyfile(root/'quality-changes.json',out/'quality-changes.json')
change_table=table(['人工质量轴','步骤','同输入换回答 / 换输入（次）','评分上升 / 下降 / 持平','缺少可比评分','总体均分变化'],[[label(r)+' / '+r['axis'],r['from'].replace('V6','v6.')+' → '+r['to'].replace('V6','v6.'),f"{r['answerChanges']} / {r['inputChanges']}",f"{r['improved']} / {r['worsened']} / {r['equal']}",r['notComparable'],f"{r['observedMeanDelta']:+.4f}"] for r in quality_changes['rows']])
status = json.loads((root/'test-status.json').read_text())
assert status['focusedPassed'] and status['scriptTypecheckPassed']
for file in ['test-status.json', 'full-failure-names.json']: shutil.copyfile(root/file, out/file)
perf = []
for name in names:
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v619', 'v623', 'v624', 'v625']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v625'/f'{name}.json')
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
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v623', 'v624', 'v625']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['cacheKey'] == runs['v5']['cacheKey']
        shutil.copyfile(root/'performance-final'/f'synthetic-{long}-{v}.json', out/f'synthetic-{long}-{v}.json')
    for i in range(3):
        measurements = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['count'] == r['k'] for r in measurements.values())
        synthetic.append(dict(scenario='N1k 长输入' if long else 'N10k 短输入', k=measurements['v5']['k'], runs=measurements, ratios={m: measurements[m.lower()]['selectionMs']/measurements['v5']['selectionMs'] for m in rounds}))
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', roundsCompleted=3, earlyStopped=False, primary=primary, quality=quality, gates=gates, passed={m: sum(g['passed'] for g in gs) for m, gs in gates.items()}, performance=perf, synthetic=synthetic, independentConfirmation='not_run', browserValidated=False, qualityChanges=[{k:v for k,v in r.items() if k!='cases'} for r in quality_changes['rows']])
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    writer = csv.DictWriter(h, fieldnames=flat[0]); writer.writeheader(); writer.writerows(flat)
ct=table(['数据集','微软公开','v5','v6.19 / v6.23 / v6.24','v6.25','v6.25 − 微软（百分点）','原目标','距原目标（百分点）'],[[r['dataset'],pct(ms[r['dataset']]),pct(gain(r,'C')),pct(gain(r,'V619')),pct(gain(r,'V625')),f"{gain(r,'V625')-ms[r['dataset']]:+.2f}",pct(max(ms[r['dataset']]+5,gain(r,'C'))),f"{gain(r,'V625')-max(ms[r['dataset']]+5,gain(r,'C')):+.2f}"] for r in coverage])
qt=table(['人工质量轴','随机','上一批 v6.22','本批起点 v6.19 / 第一轮 v6.23','第二轮 v6.24','第三轮 v6.25','原目标','v6.25 − v6.22'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','V622','V623','V624','V625']],f"{gates['V625'][6+i]['target']:.4f}",f"{r['V625']-r['V622']:+.4f}"] for i,r in enumerate(mainq)])
gt=table(['原验收条件','原目标','第一轮 v6.23','第二轮 v6.24','第三轮 v6.25','v6.25 判定'],[[g['condition'],f"{g['target']:.3f}",*[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds],g['reason']] for i,g in enumerate(gates['V625'])])
rt=table(['轮次','调整','主效果门槛','真实池 3 倍耗时门槛','提前停止条件'],[[m.replace('V6','v6.'),change,f"{summary['passed'][m]}/11",f"{sum(p['ratios'][m]<=3 for p in perf)}/10",'未满足'] for m,change in zip(rounds,['代理交换精确界限剪枝','共识与输入相关性的调和排序','调和分数的覆盖保底交换'])])
pt=table(['真实池 / K100 seed42','v5','本批起点 v6.19','v6.23','v6.24','v6.25','v6.25 / v5'],[[label(p),*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v619','v623','v624','v625']],f"{p['ratios']['V625']:.2f}×"] for p in perf])
mt=table(['真实池','v5 / v6.23 / v6.24 / v6.25 峰值 RSS MiB','对应高水位增量 MiB','v6.25 增量 1.5 倍门槛'],[[label(p),' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5','v623','v624','v625']),' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5','v623','v624','v625']),'数据不足' if p['memoryRatios']['V625'] is None else '通过' if p['memoryRatios']['V625']<=1.5 else '未通过'] for p in perf])
st=table(['合成场景','K','v5','v6.23','v6.24','v6.25','v6.25 / v5'],[[p['scenario'],p['k'],*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v623','v624','v625']],f"{p['ratios']['V625']:.2f}×"] for p in synthetic])
et=table(['数据及分层','v6.23 / v6.24 / v6.25 同 token 相对 v5','v6.24 回答替换数','v6.25 输入交换数','v6.25 代理总分增量'],[[label(r),' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds),f"{r['concordanceReplacements']:.1f}",f"{r['concordanceSwaps']:.1f}",f"{r['concordanceGain']:.4f}"] for r in primary if r['population']=='all'])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['质量防退步轴','随机','v4','v6.19 / v6.23','v6.24','v6.25'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','B4','V619','V624','V625']]] for r in guards])
size_table=table(['数据及分层','K / seed42','v6.23','v6.24','v6.25','三轮均可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table=table(['数据及分层','预算','v6.23','v6.24','v6.25','三轮均可行'],[[label(s),ratio,*[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio,suffix in [(1,'_1'),(1.1,''),(1.2,'_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,axes=plt.subplots(1,2,figsize=(16,7),layout='constrained');y=np.arange(6)
for offset,values,color,title in [(-.22,[ms[r['dataset']] for r in coverage],'#b45309','Microsoft published'),(0,[gain(r,'V619') for r in coverage],'#64748b','v6.19 / v6.23 / v6.24'),(.22,[gain(r,'V625') for r in coverage],'#0369a1','v6.25')]:
    bars=axes[0].barh(y+offset,values,height=.2,color=color,label=title);axes[0].bar_label(bars,fmt='%.1f',padding=3,fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5,gain(r,'C')) for r in coverage],y,marker='|',s=220,color='#dc2626',label='Original target');axes[0].set_yticks(y,[r['dataset'] for r in coverage]);axes[0].invert_yaxis();axes[0].set_xlabel('Vocabulary uplift over random (%)');axes[0].set_title('Coverage against public numerical targets\nMicrosoft uses a different pool/protocol');axes[0].legend(fontsize=8,loc='lower right');axes[0].margins(x=.15)
yq=np.arange(5)
for offset,m,color in [(-.22,'V619','#64748b'),(0,'V624','#0f766e'),(.22,'V625','#0369a1')]:
    values=[100*r[m]/gates['V625'][6+i]['target'] for i,r in enumerate(mainq)];bars=axes[1].barh(yq+offset,values,height=.2,color=color,label='v6.19 / v6.23' if m=='V619' else m.replace('V6','v6.'));axes[1].bar_label(bars,fmt='%.1f%%',padding=3,fontsize=8)
axes[1].axvline(100,color='#dc2626',linestyle='--',label='Original target');axes[1].set_yticks(yq,['OASST2 quality','HelpSteer2 helpfulness','CNN-DM overall','TLDR valid2 overall','TLDR valid1 overall']);axes[1].invert_yaxis();axes[1].set_xlim(0,max(117,max(100*r[m]/gates['V625'][6+i]['target'] for i,r in enumerate(mainq) for m in methods)*1.1));axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection');axes[1].legend(fontsize=8,loc='upper center',bbox_to_anchor=(.5,-.06),ncol=2)
for ax in axes:ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True)
fig.savefig(out/'comparison.png',dpi=170);fig.savefig(out/'comparison.svg',metadata={'Date':None});plt.close(fig)
old_gates=json.loads((docs/'examples/information-three-rounds-v620-v622/summary.json').read_text())['gates']['V622']
new_passes=[g['condition'] for i,g in enumerate(gates['V625']) if g['passed'] and not old_gates[i]['passed']];lost_passes=[g['condition'] for i,g in enumerate(gates['V625']) if not g['passed'] and old_gates[i]['passed']]
failures='、'.join(g['condition'] for g in gates['V625'] if not g['passed'])
text=f'''<!-- CONCORDANCE-THREE-ROUNDS-REPORT-START -->
## 本次三轮优化：v6.23 / v6.24 / v6.25

**本次 3 轮均已完成，共 297 次新候选运行，未提前停止，整体目标仍未达成。** 原要求保持不变，主效果条件依次通过 {summary['passed']['V623']}/11、{summary['passed']['V624']}/11、{summary['passed']['V625']}/11；默认继续 v4。相对上一批 v6.22，最终新增通过项：{'、'.join(new_passes) or '无'}；失去的通过项：{'、'.join(lost_passes) or '无'}。最终未通过的主条件：{failures or '无'}。资源和独立确认是额外条件，不能以主效果通过数代替。

{rt}

本批统一回到 v6.19 分支；没有叠加上一批退步的信息量分数和密集矩阵。第一轮完整回放 v6.19，后两轮检验共识与输入相关性的调和分数。返回已有起点所恢复的通过项不算新评分带来的提升，下面同时列出上一批 v6.22 和本批起点。代理分数上升不能代表人工质量改善，负面结果同样保留。最终 OASST2 quality 为 0.7134、HelpSteer2 helpfulness 为 2.848，仍低于 0.7323 / 2.928；三个摘要分层均通过原 overall 门槛，但均低于 v6.19 起点。恢复 TLDR/valid2 的通过项主要来自撤回上一批的信息量分数，本批的新调和分数又降低了它的均分。

### 与微软公开数值的直接差距

{ct}

上述为输入词汇相对各自随机基线的增幅；微软冻结参照来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。微软与本地数据池和协议不同，因此此表比较公开数值，不证明同池胜负。原目标仍为 max(微软 + 5 个百分点, v5)，并需同时满足同 token、预算及分布条件。

![三轮与微软和原目标直接比较](examples/concordance-three-rounds-v623-v625/comparison.png)

### 人工质量与原来的逐项条件

{qt}

上面的覆盖、质量表与下面 11 项表是同一批 K100 五种子结果：前六项为覆盖，后五项为人工质量。OASST2 覆盖取 all 池，quality 取原 quality-annotated 池；HelpSteer2 helpfulness 要求不低于随机和 v4，其他四项要求不低于随机的 1.10 倍和 v5。全部标签在采样返回 ID 后才读取，不使用人工质量调节当轮参数。

{gt}

质量防退步轴如下，其他标注轴仍完整保存于 JSON：

{guard_table}

### 质量变化发生在哪一步

{change_table}

这是返回 ID 后按原始人工标注进行的定位，不参与选样。计数为五个种子的替换次数，可能重复涉及同一条记录；缺少可比评分不记作持平，总体均分仍按原指标的标注分母计算。HelpSteer2 在第二轮改换 16 次参考回答，其中 10 次 helpfulness 下降、5 次上升、1 次持平，均分净降 0.060；第三轮没有改变其入选结果。OASST2 第三轮换了 5 次输入，其中 4 次评分下降。由此能确认本批新分数与人工评价不一致，不能把词项相关性解释为有用性或正确性。逐次 ID 和评分见[质量变化证据](examples/concordance-three-rounds-v623-v625/quality-changes.json)。

### 三轮算法及边界

1. **v6.23 代理交换精确界限剪枝**：保留完整 v6.19 流程，候选输入按最高回答分数降序、移出项按原分数升序检查。代理收益上界严格低于当前最好收益才结束，相等继续；平局仍按净覆盖、成本和稳定键决胜。预计算移出项独占的真实路径单元，不分配密集恢复矩阵。99 场景有序 ID、路径、原因和原诊断全部精确回放（版本名除外）。
2. **v6.24 共识与输入相关性的调和排序**：多种去重回答时，C 为原 IDF 加权 F4，R 为原输入 IDF 加权召回，分数固定为 C×R/(0.75×R+0.25×C)，分母零则零。只有一种回答时保留原 grounded 分数，缺少共识证据不作为低质量。只在同输入、真实路径兼容、QA 唯一且分数严格提高时替换；输入顺序、覆盖、成本不变。调和分数更受短板影响，可能偏向复述输入和共有错误，不是语义或事实验证。
3. **v6.25 调和分数的覆盖保底交换**：从 v6.24 结果出发，使用第 1 轮剪枝，至多 min(16,K) 次严格提高新分数的一换一；保持起点词汇覆盖下限、数量、独立输入数、原预算/TV、任务与真实路径。所有数据源相同协议，人工标签只在返回 ID 后读取。

{et}

诊断为五种子均值。同 token 保留原 QA ID 散列排序和共同最小预算，所以只换回答也可能改变截断后的词汇覆盖；审计另存固定 v6.4 预算。未以计量散列或人工标签选样。

### 性能与内存

真实池 K100/seed42 使用同机串行、每算法和数据源独立进程；摘要三个分层共用相应算法进程。计入全部回答计算，输入 MinHash 沿用带校验和的临时缓存，准备耗时另列。所有 ID 均与冻结主实验核对，保存源码、原始数据和结果哈希；以下不是生产端到端耗时。

{pt}

相对本批起点 v6.19，第一轮与最终候选的真实池耗时比值中位变化分别为 {pct(100*(median(p['runs']['v623']['selectionMs']/p['runs']['v619']['selectionMs'] for p in perf)-1))}、{pct(100*(median(p['runs']['v625']['selectionMs']/p['runs']['v619']['selectionMs'] for p in perf)-1))}。最终相对 v5 的 3 倍耗时条件通过 {sum(p['ratios']['V625']<=3 for p in perf)}/10。单次测量受运行时、GC 和同机服务影响，不是稳定加速比或置信区间。

{mt}

RSS 增量是选样前后进程高水位之差，仅为增量内存代理。零分母或零增量标“数据不足”，不能视作通过 1.5 倍门槛；完整四 Worker 的实际资源验证仍未完成。

{st}

短输入 N10k、长输入 N1k 均测 K20/100/500；相同 fixture，保留冷特征准备与本次加载耗时，累计 RSS 不当作精确分配量。合成边界不能替代真实池、完整 Worker 或 UI。

### 敏感性与验证

沿用八源原池、K100 的种子 42/100/101/102/103、seed42 的 K20/K500 及 1.00/1.10/1.20 预算，每轮 77 主场景加 22 预算敏感性。下表列 all 池，OASST2 有标注子池全部场景同样保存于原始结果。

{size_table}

{budget_table}

每轮从原文本独立复算词汇、成本、TV、上界和全部人工质量，核对历史 ID 与源码/数据哈希。各预算均检查 v6.23 精确回放、v6.24 输入/成本/覆盖不变、v6.25 覆盖及独立输入数保底；代理分数单调性另检查报告值，不能混称为人工质量独立验证。测试覆盖真实路径及混合变体，不以公开池的空路径替代路径验证。

新增 6 项测试，专项 {status['focused']['pass']}/{status['focused']['tests']} 通过：随机/浮点/长输入/平局界限剪枝回放、多个预算/数量、调和分数解析值与零证据、Unicode 与重复回答、共享特征不变、兼容路径、交换边界、回退和取消。新采样器、研究脚本和测试严格类型检查通过。

全仓测试 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过。相对上批失败节点新增 {len(status['newFailureNames'])} 项，消失 {len(status['resolvedFailureNames'])} 项；原始全量结果不被针对性复测覆盖。

{status.get('failureReview','')}

当前池已反复用于开发，仍未完成新来源独立确认。候选未接入生产 Worker，**本次未在浏览器中验证新候选**；旧 v4 UI 证据不代替本批。默认继续 v4，本次三轮结束，不追加第四轮。

证据：[汇总](examples/concordance-three-rounds-v623-v625/summary.json)、[逐场景指标](examples/concordance-three-rounds-v623-v625/metrics.csv)、[源码哈希](examples/concordance-three-rounds-v623-v625/implementation.json)、[测试记录](examples/concordance-three-rounds-v623-v625/test-status.json)、[全量失败名称](examples/concordance-three-rounds-v623-v625/full-failure-names.json)、[证据校验](examples/concordance-three-rounds-v623-v625/report-verification.json)。24 份压缩原始结果及各轮 plan/verification、40 份真实池与 8 份合成性能记录均在同目录；以下历史报告保持原样。

<!-- CONCORDANCE-THREE-ROUNDS-REPORT-END -->

'''
report=docs/'eight-datasets-comparison-report.md';old=report.read_text()
if old.startswith('<!-- CONCORDANCE-THREE-ROUNDS-REPORT-START -->'):old=old.split('<!-- CONCORDANCE-THREE-ROUNDS-REPORT-END -->\n\n',1)[1]
report.write_text(text+old)
files=['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-bounded-proxy','budgeted-bounded','answer-concordance','budgeted-concordance']]+['scripts/trace-datasets/'+n for n in ['compare-concordance-rounds.ts','audit-concordance-rounds.ts','benchmark-concordance-rounds.ts','benchmark-concordance-rounds-synthetic.ts','report-concordance-rounds.py','explain-concordance-quality.ts']]+['test/trace-datasets-bounded-concordance.test.ts']
(out/'implementation.json').write_text(json.dumps({f:sha(f) for f in files},indent=2))
print(json.dumps({'rounds':3,'passed':summary['passed'],'report':str(report)},ensure_ascii=False))
