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
out = docs/'examples'/'priced-three-rounds-v614-v616'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V614': 'v614', 'V615': 'v615', 'V616': 'v616'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V613', 'V614', 'V615', 'V616']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-priced-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V616': reports[name] = report
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
        eq = [e for e in audits['V616']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, priceProbes=mean(s['methods']['V614']['optimization']['priceProbes'] for s in trials), crossingSteps=mean(s['methods']['V615']['crossing']['steps'] for s in trials), crossingOverBudget=mean(s['methods']['V615']['crossing']['overBudgetSteps'] for s in trials), crossingUpdates=mean(s['methods']['V615']['crossing']['bestUpdates'] for s in trials), highRecallReplacements=mean(s['methods']['V616']['highRecall']['replacements'] for s in trials)))
        for axis in trials[0]['methods']['V616']['metrics']['quality']:
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
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v613', 'v614', 'v615', 'v616']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v616'/f'{name}.json')
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
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v614', 'v615', 'v616']}
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
ct = table(['数据集', '微软公开', 'v5', '上一批 v6.13', 'v6.14', 'v6.15 / v6.16', 'v6.16 − 微软（百分点）', '原目标', '距原目标（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), *[pct(gain(r,m)) for m in ['C','V613','V614','V616']], f"{gain(r,'V616')-ms[r['dataset']]:+.2f}", pct(max(ms[r['dataset']]+5,gain(r,'C'))), f"{gain(r,'V616')-max(ms[r['dataset']]+5,gain(r,'C')):+.2f}"] for r in coverage])
qt = table(['人工质量轴', '随机', '上一批 v6.13', 'v6.14', 'v6.15', 'v6.16', '原目标', 'v6.16 − v6.13'], [[label(r)+' / '+r['axis'], *[f"{r[m]:.4f}" for m in ['B0','V613','V614','V615','V616']], f"{gates['V616'][6+i]['target']:.4f}", f"{r['V616']-r['V613']:+.4f}"] for i,r in enumerate(mainq)])
gt = table(['原验收条件', '原目标', '第一轮 v6.14', '第二轮 v6.15', '第三轮 v6.16', 'v6.16 判定'], [[g['condition'],f"{g['target']:.3f}",*[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds],g['reason']] for i,g in enumerate(gates['V616'])])
rt = table(['轮次','调整','主效果门槛','真实池 3 倍耗时门槛','提前停止条件'],[[m.replace('V6','v6.'),change,f"{summary['passed'][m]}/11",f"{sum(p['ratios'][m]<=3 for p in perf)}/10",'未满足'] for m,change in zip(rounds,['自适应成本定价构造','价格引导预算跨越','更偏召回的加权 F4'])])
pt = table(['真实池 / K100 seed42','v5','上一批 v6.13','v6.14','v6.15','v6.16','v6.16 / v5'],[[label(p),*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v613','v614','v615','v616']],f"{p['ratios']['V616']:.2f}×"] for p in perf])
mt = table(['真实池','v5 / v6.14 / v6.15 / v6.16 峰值 RSS MiB','对应高水位增量 MiB','v6.16 增量 1.5 倍门槛'],[[label(p),' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5','v614','v615','v616']),' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5','v614','v615','v616']),'数据不足' if p['memoryRatios']['V616'] is None else '通过' if p['memoryRatios']['V616']<=1.5 else '未通过'] for p in perf])
st = table(['合成场景','K','v5','v6.14','v6.15','v6.16','v6.16 / v5'],[[p['scenario'],p['k'],*[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5','v614','v615','v616']],f"{p['ratios']['V616']:.2f}×"] for p in synthetic])
et = table(['数据及分层','v6.14 / v6.15 / v6.16 同 token 相对 v5','价格探测数','跨越步数 / 超预算步数 / 可行解改进数','F4 回答替换数'],[[label(r),' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds),f"{r['priceProbes']:.1f}",f"{r['crossingSteps']:.1f} / {r['crossingOverBudget']:.1f} / {r['crossingUpdates']:.1f}",f"{r['highRecallReplacements']:.1f}"] for r in primary if r['population']=='all'])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['质量防退步轴','随机','v4','v6.13','v6.14','v6.15','v6.16'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.4f}' for m in ['B0','B4','V613','V614','V615','V616']]] for r in guards])
size_table=table(['数据及分层','K / seed42','v6.14','v6.15','v6.16','三轮均可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table=table(['数据及分层','预算','v6.14','v6.15','v6.16','三轮均可行'],[[label(s),ratio,*[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds],all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio,suffix in [(1,'_1'),(1.1,''),(1.2,'_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,axes=plt.subplots(1,2,figsize=(16,7),layout='constrained')
y=np.arange(6)
for offset,values,color,title in [(-.27,[ms[r['dataset']] for r in coverage],'#b45309','Microsoft published'),(-.09,[gain(r,'V613') for r in coverage],'#64748b','v6.13 previous'),(.09,[gain(r,'V614') for r in coverage],'#0f766e','v6.14'),(.27,[gain(r,'V616') for r in coverage],'#0369a1','v6.15 / v6.16')]:
    bars=axes[0].barh(y+offset,values,height=.17,color=color,label=title); axes[0].bar_label(bars,fmt='%.1f',padding=3,fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5,gain(r,'C')) for r in coverage],y,marker='|',s=220,color='#dc2626',label='Original target')
axes[0].set_yticks(y,[r['dataset'] for r in coverage]); axes[0].invert_yaxis(); axes[0].set_xlabel('Vocabulary uplift over random (%)'); axes[0].set_title('Coverage against public numerical targets\nMicrosoft uses a different pool/protocol'); axes[0].legend(fontsize=8,loc='lower right'); axes[0].margins(x=.15)
yq=np.arange(5)
for offset,m,color in [(-.27,'V613','#64748b'),(-.09,'V614','#0f766e'),(.09,'V615','#7c3aed'),(.27,'V616','#0369a1')]:
    values=[100*r[m]/gates['V616'][6+i]['target'] for i,r in enumerate(mainq)]
    bars=axes[1].barh(yq+offset,values,height=.17,color=color,label=m.replace('V6','v6.')); axes[1].bar_label(bars,fmt='%.1f%%',padding=3,fontsize=8)
axes[1].axvline(100,color='#dc2626',linestyle='--',label='Original target'); axes[1].set_yticks(yq,['OASST2 quality','HelpSteer2 helpfulness','CNN-DM overall','TLDR valid2 overall','TLDR valid1 overall']); axes[1].invert_yaxis(); axes[1].set_xlim(0,max(117,max(100*r[m]/gates['V616'][6+i]['target'] for i,r in enumerate(mainq) for m in methods)*1.1)); axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection'); axes[1].legend(fontsize=8,loc='upper center',bbox_to_anchor=(.5,-.06),ncol=3)
for ax in axes: ax.grid(axis='x',alpha=.2); ax.set_axisbelow(True)
fig.savefig(out/'comparison.png',dpi=170); fig.savefig(out/'comparison.svg',metadata={'Date':None}); plt.close(fig)
old_summary=json.loads((docs/'examples/weighted-three-rounds-v611-v613/summary.json').read_text())
old_gates=old_summary['gates']['V613']
new_passes=[g['condition'] for i,g in enumerate(gates['V616']) if g['passed'] and not old_gates[i]['passed']]
lost_passes=[g['condition'] for i,g in enumerate(gates['V616']) if not g['passed'] and old_gates[i]['passed']]
failures='、'.join(g['condition'] for g in gates['V616'] if not g['passed'])
text=f'''<!-- PRICED-THREE-ROUNDS-REPORT-START -->
## 本次三轮优化：v6.14 / v6.15 / v6.16

**本次 3 轮均已完成，共 297 次新候选运行，未提前停止，整体目标仍未达成。** 原要求保持不变，主效果条件依次通过 {summary['passed']['V614']}/11、{summary['passed']['V615']}/11、{summary['passed']['V616']}/11；默认继续 v4。相对上一批 v6.13，最终新增通过项：{'、'.join(new_passes) or '无'}；失去的通过项：{'、'.join(lost_passes) or '无'}。最终未通过的主条件：{failures or '无'}。资源和独立确认是额外放行条件，不能用主效果通过数代替。

{rt}

本批的突破在覆盖：NoRobots 从上一批的 {next(gain(r,'V613') for r in coverage if r['dataset']=='NoRobots'):.2f}% 提升到 {next(gain(r,'V616') for r in coverage if r['dataset']=='NoRobots'):.2f}%，OASST2 从 {next(gain(r,'V613') for r in coverage if r['dataset']=='OASST2'):.2f}% 提升到 {next(gain(r,'V616') for r in coverage if r['dataset']=='OASST2'):.2f}%，六项覆盖条件最终均通过。代价是 OASST2 quality 从 0.7357 降至 0.7227、HelpSteer2 helpfulness 从 2.880 降至 2.798，前者失去已通过的质量条件，后者距离目标更远。第三轮 F4 没有更换 HelpSteer2 的参考回答；它提高了三个摘要子集的 overall，但未解决剩余两项质量条件。

### 与微软公开数值的直接差距

{ct}

六项数值均为输入词汇覆盖相对各自随机基线的增幅，微软冻结参照来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。本地与微软池和协议不同，此表是公开数值比较，不能宣称同池胜负。原目标仍是 max(微软 + 5 个百分点, v5)，并须同时通过同 token 与约束门槛。

![本次三轮与微软及原目标的差距](examples/priced-three-rounds-v614-v616/comparison.png)

### 人工质量与逐项门槛

{qt}

上述两张数值表与下表使用同一批 K100 五种子结果：前六项是覆盖，后五项是人工质量，不能相互抵消。OASST2 覆盖用 all 池、quality 用原 quality-annotated 池；HelpSteer2 helpfulness 要求不低于随机和 v4，其他四项质量要求不低于随机的 1.10 倍和 v5。标签仅在采样返回 ID 后读取。

{gt}

质量防退步轴全部保留如下，其他人工标注轴保存于 JSON。词项共识无法保证事实正确或有用性；加大召回偏好也可能引入冗长和共同错误，质量退步不得被覆盖收益掩盖。

{guard_table}

### 三轮方案及实际诊断

1. **v6.14 自适应成本定价构造**：保留 v5 任务/真实路径保底、原预算与 TV，用三种成本保留贪心和可行基线提供起点。额外按“边际词汇 − 价格 × token”构造，价格从零开始，至多四次加倍、六次二分；探测以修复前成本更新价格，最终只考虑原约束可行解。最后在最好解上执行至多 min(64,K) 次完整单交换。旧链反复短名单改善、桥接、重建、禁忌和二换二阶段移除；参考回答直接计算 IDF 加权 F2。这是新的速度/效果取舍，不声称等价回放或覆盖不低于 v6.13，也不把价格二分当作全局最优证明（离散贪心成本未必单调）。
2. **v6.15 价格引导预算跨越**：两条最多 min(32,K) 步轨迹，初始价格为覆盖/预算的 0.5 与 2 倍，按“净覆盖 + 价格 × 节省成本”排序，价格每步乘 exp(0.5×(cost/budget−1))，输入有 7 步禁忌。中间成本至多原预算 1.25 倍，数量、独立输入数、TV、起点任务及真实路径始终受约束；只有回到原预算且覆盖提高，或等覆盖成本下降的结果才输出。找不到改进就保留可行起点，未放宽最终预算。
3. **v6.16 加权 F4**：保留 v6.15 输入序列，将同输入参考回答的支持分数改为 17×加权交集/(16×支持词项权重和+候选词项权重和)。词项 IDF 沿用每输入组去重频次，最多 32 个不同支持回答；只在分数严格提高、真实路径兼容和 QA 不重复时替换。输入词汇/成本不变，质量由盲选后的人工标签验收，不使用标签选样。

{et}

这些诊断是五种子均值；中间超预算步数不代表最终预算违规。同 token 沿用原 QA ID 排序、共同最小预算，因此换回答会影响截断计量的顺序；汇总和审计同时保留固定 v6.4 预算。未利用计量散列决定选样。

### 耗时和内存

真实池 K100/seed42 在同机串行独立进程测试，包含回答特征开销；每个算法入选 ID 与冻结结果逐一匹配，源码、输入和结果哈希一并保存。输入 MinHash 使用原带校验和的临时缓存，准备耗时另列；摘要三个分层共享各自算法进程。以下不是生产端到端耗时。

{pt}

相对上一批 v6.13，v6.14 和最终 v6.16 的真实池耗时比值中位变化分别为 {pct(100*(median(p['runs']['v614']['selectionMs']/p['runs']['v613']['selectionMs'] for p in perf)-1))}、{pct(100*(median(p['runs']['v616']['selectionMs']/p['runs']['v613']['selectionMs'] for p in perf)-1))}。最终 3 倍 v5 耗时门槛通过 {sum(p['ratios']['V616']<=3 for p in perf)}/10。单次测量受 GC、运行时和同机服务影响，不代表稳定加速比或置信区间。

{mt}

RSS 增量为选样前后进程高水位差，仅为增量内存代理；分母或增量为零时标“数据不足”，不能判为通过。四 Worker 的真实资源与端到端性能尚未验证。

{st}

相同合成 fixture 覆盖 N10k 短输入及 N1k 长输入的 K20/100/500，保留原特征冷准备、本次缓存加载和累计 RSS；合成测试不代替真实池、Worker 或 UI。

### 敏感性与复核

原八源冻结池、K100 种子 42/100/101/102/103，以及 seed42 的 K20/K500、预算 1.00/1.10/1.20 保持不变。每轮 77 主场景加 22 预算敏感性。下表列 all 池，OASST2 有标注子池的全部结果也在原始证据中。

{size_table}

{budget_table}

每轮审计从原始文本独立复算词汇、成本、TV、覆盖上界及人工质量，校验历史结果未变化。验证 v6.15 全预算可行覆盖不低于 v6.14、等覆盖不增加成本，v6.16 全预算保持 v6.15 输入序列/覆盖/成本；真实路径另有混合输入测试。累计入选记录数含所有历史对照，不等于新增运行次数。

新增 6 项测试，专项 {status['focused']['pass']}/{status['focused']['tests']} 通过：直接 F2 与旧特征等价、F4 解析值、支持去重和上限、多预算/数量/输入逆序、真实路径、超预算中间态不能发布、微型穷举上界、取消与默认保持。新代码、研究脚本和测试严格类型检查通过。

全仓测试 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过。相对上一批失败名称新增 {len(status['newFailureNames'])} 项、消失 {len(status['resolvedFailureNames'])} 项；完整记录和复查说明保存于测试证据。全仓类型检查状态及原始错误也保留，不能据此宣称全仓通过。

{status.get('failureReview','')}

本批仍使用已参与多轮开发的池，尚未完成新来源独立确认。候选未接入生产 Worker，**本次未在浏览器中验证新候选**，旧 v4 UI 证据不能替代本次。默认继续 v4，本批三轮已结束，不继续第四轮。

证据：[汇总](examples/priced-three-rounds-v614-v616/summary.json)、[逐场景指标](examples/priced-three-rounds-v614-v616/metrics.csv)、[源码哈希](examples/priced-three-rounds-v614-v616/implementation.json)、[测试记录](examples/priced-three-rounds-v614-v616/test-status.json)、[全量失败名称](examples/priced-three-rounds-v614-v616/full-failure-names.json)、[证据校验](examples/priced-three-rounds-v614-v616/report-verification.json)。三个版本目录保存 24 份压缩原始结果及 plan/verification，同目录保存 40 份真实池、8 份合成性能记录。以下历史报告和证据保持原样。

<!-- PRICED-THREE-ROUNDS-REPORT-END -->

'''
report=docs/'eight-datasets-comparison-report.md'; old=report.read_text()
if old.startswith('<!-- PRICED-THREE-ROUNDS-REPORT-START -->'): old=old.split('<!-- PRICED-THREE-ROUNDS-REPORT-END -->\n\n',1)[1]
report.write_text(text+old)
files=['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-priced-core','answer-direct','budgeted-priced','budgeted-crossing','answer-high-recall']]+['scripts/trace-datasets/'+n for n in ['compare-priced-rounds.ts','audit-priced-rounds.ts','benchmark-priced-rounds.ts','benchmark-priced-rounds-synthetic.ts','report-priced-rounds.py']]+['test/trace-datasets-priced.test.ts']
(out/'implementation.json').write_text(json.dumps({f:sha(f) for f in files},indent=2))
print(json.dumps({'rounds':3,'passed':summary['passed'],'report':str(report)},ensure_ascii=False))
