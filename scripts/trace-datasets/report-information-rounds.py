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
out = docs/'examples'/'information-three-rounds-v620-v622'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V620': 'v620', 'V621': 'v621', 'V622': 'v622'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V619', 'V620', 'V621', 'V622']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-information-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V622': reports[name] = report
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
        eq = [e for e in audits['V622']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, informationReplacements=mean(s['methods']['V621']['information']['replacements'] for s in trials), informationSwaps=mean(s['methods']['V622']['informationSearch']['swaps'] for s in trials), informationGain=mean((s['methods']['V622']['informationSearch']['finalScore'] or 0)-(s['methods']['V622']['informationSearch']['initialScore'] or 0) for s in trials)))
        for axis in trials[0]['methods']['V622']['metrics']['quality']:
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
status = json.loads((root/'test-status.json').read_text())
assert status['focusedPassed'] and status['scriptTypecheckPassed']
for file in ['test-status.json', 'full-failure-names.json']: shutil.copyfile(root/file, out/file)
perf = []
for name in names:
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v619', 'v620', 'v621', 'v622']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v622'/f'{name}.json')
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
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v620', 'v621', 'v622']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['cacheKey'] == runs['v5']['cacheKey']
        shutil.copyfile(root/'performance-final'/f'synthetic-{long}-{v}.json', out/f'synthetic-{long}-{v}.json')
    for i in range(3):
        measurements = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['count'] == r['k'] for r in measurements.values())
        synthetic.append(dict(scenario='N1k 长输入' if long else 'N10k 短输入', k=measurements['v5']['k'], runs=measurements, ratios={m: measurements[m.lower()]['selectionMs']/measurements['v5']['selectionMs'] for m in rounds}))
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', roundsCompleted=3, earlyStopped=False, primary=primary, quality=quality, gates=gates, passed={m: sum(g['passed'] for g in gs) for m, gs in gates.items()}, performance=perf, synthetic=synthetic, independentConfirmation='not_run', browserValidated=False)
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    writer = csv.DictWriter(h, fieldnames=flat[0]); writer.writeheader(); writer.writerows(flat)
ct=table(['数据集','微软公开','v5','v6.19 / v6.20 / v6.21','v6.22','v6.22 − 微软（百分点）','原目标','距原目标（百分点）'],[[r['dataset'],pct(ms[r['dataset']]),pct(gain(r,'C')),pct(gain(r,'V619')),pct(gain(r,'V622')),f"{gain(r,'V622')-ms[r['dataset']]:+.2f}",pct(max(ms[r['dataset']]+5,gain(r,'C'))),f"{gain(r,'V622')-max(ms[r['dataset']]+5,gain(r,'C')):+.2f}"] for r in coverage])
qt=table(['人工质量轴','随机','上一批 v6.19','v6.20','v6.21','v6.22','原目标','v6.22 − v6.19'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','V619','V620','V621','V622']],f"{gates['V622'][6+i]['target']:.4f}",f"{r['V622']-r['V619']:+.4f}"] for i,r in enumerate(mainq)])
gt=table(['原验收条件','原目标','第一轮 v6.20','第二轮 v6.21','第三轮 v6.22','v6.22 判定'],[[g['condition'],f"{g['target']:.3f}",*[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds],g['reason']] for i,g in enumerate(gates['V622'])])
rt=table(['轮次','调整','主效果门槛','真实池 3 倍耗时门槛','提前停止条件'],[[m.replace('V6','v6.'),change,f"{summary['passed'][m]}/11",f"{sum(p['ratios'][m]<=3 for p in perf)}/10",'未满足'] for m,change in zip(rounds,['增量覆盖与恢复收益索引','非重复信息量辅助回答排序','新代理的覆盖保底交换'])])
pt=table(['真实池 / K100 seed42','v5','上一批 v6.19','v6.20','v6.21','v6.22','v6.22 / v5'],[[label(p),*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v619','v620','v621','v622']],f"{p['ratios']['V622']:.2f}×"] for p in perf])
mt=table(['真实池','v5 / v6.20 / v6.21 / v6.22 峰值 RSS MiB','对应高水位增量 MiB','v6.22 增量 1.5 倍门槛'],[[label(p),' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5','v620','v621','v622']),' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5','v620','v621','v622']),'数据不足' if p['memoryRatios']['V622'] is None else '通过' if p['memoryRatios']['V622']<=1.5 else '未通过'] for p in perf])
st=table(['合成场景','K','v5','v6.20','v6.21','v6.22','v6.22 / v5'],[[p['scenario'],p['k'],*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v620','v621','v622']],f"{p['ratios']['V622']:.2f}×"] for p in synthetic])
et=table(['数据及分层','v6.20 / v6.21 / v6.22 同 token 相对 v5','v6.21 回答替换数','v6.22 输入交换数','v6.22 代理总分增量'],[[label(r),' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds),f"{r['informationReplacements']:.1f}",f"{r['informationSwaps']:.1f}",f"{r['informationGain']:.4f}"] for r in primary if r['population']=='all'])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['质量防退步轴','随机','v4','v6.19 / v6.20','v6.21','v6.22'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','B4','V619','V621','V622']]] for r in guards])
size_table=table(['数据及分层','K / seed42','v6.20','v6.21','v6.22','三轮均可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table=table(['数据及分层','预算','v6.20','v6.21','v6.22','三轮均可行'],[[label(s),ratio,*[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio,suffix in [(1,'_1'),(1.1,''),(1.2,'_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,axes=plt.subplots(1,2,figsize=(16,7),layout='constrained');y=np.arange(6)
for offset,values,color,title in [(-.22,[ms[r['dataset']] for r in coverage],'#b45309','Microsoft published'),(0,[gain(r,'V619') for r in coverage],'#64748b','v6.19 / v6.20 / v6.21'),(.22,[gain(r,'V622') for r in coverage],'#0369a1','v6.22')]:
    bars=axes[0].barh(y+offset,values,height=.2,color=color,label=title);axes[0].bar_label(bars,fmt='%.1f',padding=3,fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5,gain(r,'C')) for r in coverage],y,marker='|',s=220,color='#dc2626',label='Original target');axes[0].set_yticks(y,[r['dataset'] for r in coverage]);axes[0].invert_yaxis();axes[0].set_xlabel('Vocabulary uplift over random (%)');axes[0].set_title('Coverage against public numerical targets\nMicrosoft uses a different pool/protocol');axes[0].legend(fontsize=8,loc='lower right');axes[0].margins(x=.15)
yq=np.arange(5)
for offset,m,color in [(-.22,'V619','#64748b'),(0,'V621','#0f766e'),(.22,'V622','#0369a1')]:
    values=[100*r[m]/gates['V622'][6+i]['target'] for i,r in enumerate(mainq)];bars=axes[1].barh(yq+offset,values,height=.2,color=color,label='v6.19 / v6.20' if m=='V619' else m.replace('V6','v6.'));axes[1].bar_label(bars,fmt='%.1f%%',padding=3,fontsize=8)
axes[1].axvline(100,color='#dc2626',linestyle='--',label='Original target');axes[1].set_yticks(yq,['OASST2 quality','HelpSteer2 helpfulness','CNN-DM overall','TLDR valid2 overall','TLDR valid1 overall']);axes[1].invert_yaxis();axes[1].set_xlim(0,max(117,max(100*r[m]/gates['V622'][6+i]['target'] for i,r in enumerate(mainq) for m in methods)*1.1));axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection');axes[1].legend(fontsize=8,loc='upper center',bbox_to_anchor=(.5,-.06),ncol=2)
for ax in axes:ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True)
fig.savefig(out/'comparison.png',dpi=170);fig.savefig(out/'comparison.svg',metadata={'Date':None});plt.close(fig)
old_gates=json.loads((docs/'examples/shared-three-rounds-v617-v619/summary.json').read_text())['gates']['V619']
new_passes=[g['condition'] for i,g in enumerate(gates['V622']) if g['passed'] and not old_gates[i]['passed']];lost_passes=[g['condition'] for i,g in enumerate(gates['V622']) if not g['passed'] and old_gates[i]['passed']]
failures='、'.join(g['condition'] for g in gates['V622'] if not g['passed'])
text=f'''<!-- INFORMATION-THREE-ROUNDS-REPORT-START -->
## 本次三轮优化：v6.20 / v6.21 / v6.22

**本次 3 轮均已完成，共 297 次新候选运行，未提前停止，整体目标仍未达成。** 原要求保持不变，主效果条件依次通过 {summary['passed']['V620']}/11、{summary['passed']['V621']}/11、{summary['passed']['V622']}/11；默认继续 v4。相对上一批 v6.19，最终新增通过项：{'、'.join(new_passes) or '无'}；失去的通过项：{'、'.join(lost_passes) or '无'}。最终未通过的主条件：{failures or '无'}。资源和独立确认是额外条件，不能以主效果通过数代替。

{rt}

第一轮完整回放 v6.19 选择与诊断，质量和覆盖不变。第二轮加入非重复信息量后，OASST2 quality 从 0.7145 升到 0.7252，第三轮再升至 0.7288，但仍低于 0.7323。代价是 HelpSteer2 helpfulness 从 2.908 降到 2.850、2.846，correctness 从 3.004 降至 2.942；TLDR/valid2 overall 从 5.4175 降至 5.1912，失去一个主门槛通过项。新代理没有全面改善质量，v6.21/v6.22 不作为效果升级结论，也不启用。 本次串行单次测量中，v6.20 与 v6.22 相对起点的耗时比值中位分别上升约 34.45% 和 122.92%，第一轮也未获得预期加速；不能把等价回放通过当成性能通过。

### 与微软公开数值的直接差距

{ct}

上述为输入词汇相对各自随机基线的增幅；微软冻结参照来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。微软与本地数据池和协议不同，因此此表比较公开数值，不证明同池胜负。原目标仍为 max(微软 + 5 个百分点, v5)，并需同时满足同 token、预算及分布条件。

![三轮与微软和原目标直接比较](examples/information-three-rounds-v620-v622/comparison.png)

### 人工质量与原来的逐项条件

{qt}

上面的覆盖、质量表与下面 11 项表是同一批 K100 五种子结果：前六项为覆盖，后五项为人工质量。OASST2 覆盖取 all 池，quality 取原 quality-annotated 池；HelpSteer2 helpfulness 要求不低于随机和 v4，其他四项要求不低于随机的 1.10 倍和 v5。全部标签在采样返回 ID 后才读取，不使用人工质量调节当轮参数。

{gt}

质量防退步轴如下，其他标注轴仍完整保存于 JSON：

{guard_table}

### 三轮算法及边界

1. **v6.20 增量覆盖与恢复收益索引**：保留完整 v6.19 流程，只优化价格跨越搜索。一次建立词项倒排，引用计数越过零时增量更新各输入新增词汇数；每步用唯一持有词项倒排计算移出项恢复收益，避免重复扫描全部输入词项。恢复计数最多 2,000,000 个（约 8 MiB），超过上限完整回退旧扫描。全部搜索轨迹、接受规则、平局顺序和取消机制不变；99 场景回放全部有序 ID、路径、原因及原诊断（策略名除外）。无新增持久存储。
2. **v6.21 非重复信息量辅助回答排序**：新分数固定为 0.75×v6.18 回答分数 + 0.25×U/(U+32)×R。U 为独立回答词项数，R 为不同连续三词组数/全部连续三词组数，少于三词时 R=1。沿用 Unicode 分词、同回答去重和路径兼容约束；只在分数严格提高时替换同输入参考回答，输入顺序、成本和原始覆盖保持。这个代理会偏好一定长度和非重复词汇，也可能奖励词汇丰富的错误回答，不验证事实或语义。
3. **v6.22 新代理的覆盖保底交换**：从 v6.21 起点复用至多 min(16,K) 次可行一换一协议，使用第 2 轮固定分数；每步严格提高该代理总分。数量、独立输入数、原预算/TV、起点任务和真实路径保持，原始覆盖不低于起点。同分按净覆盖、成本节省和稳定键排序。人工标签只在返回 ID 后复算，不随当轮结果调参。

{et}

诊断为五种子均值。同 token 保留原 QA ID 散列排序和共同最小预算，所以只换回答也可能改变截断后的词汇覆盖；审计另存固定 v6.4 预算。未以计量散列或人工标签选样。

### 性能与内存

真实池 K100/seed42 使用同机串行、每算法和数据源独立进程；摘要三个分层共用相应算法进程。计入全部回答计算，输入 MinHash 沿用带校验和的临时缓存，准备耗时另列。所有 ID 均与冻结主实验核对，保存源码、原始数据和结果哈希；以下不是生产端到端耗时。

{pt}

相对上一批 v6.19，第一轮与最终候选的真实池耗时比值中位变化分别为 {pct(100*(median(p['runs']['v620']['selectionMs']/p['runs']['v619']['selectionMs'] for p in perf)-1))}、{pct(100*(median(p['runs']['v622']['selectionMs']/p['runs']['v619']['selectionMs'] for p in perf)-1))}。最终相对 v5 的 3 倍耗时条件通过 {sum(p['ratios']['V622']<=3 for p in perf)}/10。单次测量受运行时、GC 和同机服务影响，不是稳定加速比或置信区间。

{mt}

RSS 增量是选样前后进程高水位之差，仅为增量内存代理。零分母或零增量标“数据不足”，不能视作通过 1.5 倍门槛；完整四 Worker 的实际资源验证仍未完成。

{st}

短输入 N10k、长输入 N1k 均测 K20/100/500；相同 fixture，保留冷特征准备与本次加载耗时，累计 RSS 不当作精确分配量。合成边界不能替代真实池、完整 Worker 或 UI。

### 敏感性与验证

沿用八源原池、K100 的种子 42/100/101/102/103、seed42 的 K20/K500 及 1.00/1.10/1.20 预算，每轮 77 主场景加 22 预算敏感性。下表列 all 池，OASST2 有标注子池全部场景同样保存于原始结果。

{size_table}

{budget_table}

每轮从原文本独立复算词汇、成本、TV、上界和全部人工质量，核对历史 ID 与源码/数据哈希。各预算均检查 v6.20 精确回放、v6.21 输入/成本/覆盖不变、v6.22 覆盖及独立输入数保底；代理分数单调性另检查报告值，不能混称为人工质量独立验证。测试覆盖真实路径及混合变体，不以公开池的空路径替代路径验证。

新增 6 项测试，专项 {status['focused']['pass']}/{status['focused']['tests']} 通过：随机/长输入/平局增量回放、多个预算/数量、词汇饱和及重复惩罚解析值、Unicode 分词、共享特征不变、兼容路径、交换边界、回退和取消。新采样器、研究脚本和测试严格类型检查通过。

全仓测试 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过。相对上批失败节点新增 {len(status['newFailureNames'])} 项，消失 {len(status['resolvedFailureNames'])} 项；原始全量结果不被针对性复测覆盖。

{status.get('failureReview','')}

当前池已反复用于开发，仍未完成新来源独立确认。候选未接入生产 Worker，**本次未在浏览器中验证新候选**；旧 v4 UI 证据不代替本批。默认继续 v4，本次三轮结束，不追加第四轮。

证据：[汇总](examples/information-three-rounds-v620-v622/summary.json)、[逐场景指标](examples/information-three-rounds-v620-v622/metrics.csv)、[源码哈希](examples/information-three-rounds-v620-v622/implementation.json)、[测试记录](examples/information-three-rounds-v620-v622/test-status.json)、[全量失败名称](examples/information-three-rounds-v620-v622/full-failure-names.json)、[证据校验](examples/information-three-rounds-v620-v622/report-verification.json)。24 份压缩原始结果及各轮 plan/verification、40 份真实池与 8 份合成性能记录均在同目录；以下历史报告保持原样。

<!-- INFORMATION-THREE-ROUNDS-REPORT-END -->

'''
report=docs/'eight-datasets-comparison-report.md';old=report.read_text()
if old.startswith('<!-- INFORMATION-THREE-ROUNDS-REPORT-START -->'):old=old.split('<!-- INFORMATION-THREE-ROUNDS-REPORT-END -->\n\n',1)[1]
report.write_text(text+old)
files=['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-incremental-crossing','budgeted-incremental','answer-information','budgeted-information']]+['scripts/trace-datasets/'+n for n in ['compare-information-rounds.ts','audit-information-rounds.ts','benchmark-information-rounds.ts','benchmark-information-rounds-synthetic.ts','report-information-rounds.py']]+['test/trace-datasets-incremental-information.test.ts']
(out/'implementation.json').write_text(json.dumps({f:sha(f) for f in files},indent=2))
print(json.dumps({'rounds':3,'passed':summary['passed'],'report':str(report)},ensure_ascii=False))
