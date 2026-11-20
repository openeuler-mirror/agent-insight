'use client';
import { adjacentContextDiff, type ContextEntry, type ContextRequest } from '@/lib/ingest/deepseek-harness-otel/context-view';

export function HarnessAdjacentDiff({ entries, current, zh }: { entries: ContextEntry[]; current?: ContextRequest; zh: boolean }) {
  if (!current) return <p>{zh ? '请选择左侧 LLM 请求。' : 'Select an LLM request.'}</p>;
  const result = adjacentContextDiff(entries, current);
  const reasons: Record<string, string> = zh ? {
    'projection-not-collected': '该请求未采集 dsh-context 投影，无法确认是否早于插件接入。',
    'projection-not-installed': '该请求读取时未检测到匹配 profile 的 dsh-context。',
    'projection-unsupported-version': '该请求的 dsh-context 版本不在已验证范围（0.85.1）。',
    'projection-timeout': '读取已有 dsh-context 投影超时；不代表请求没有上下文。',
    'projection-source-busy': 'dsh-context 源忙，本次没有取得投影。',
    'projection-connection-unavailable': '缺少 dsh-context connection 服务或已有连接不可用。',
    'projection-unmatched-request': '投影请求序号或轮步未能唯一匹配，不按时间猜测。',
    'projection-incomplete-categories': '投影分类字段不完整，未展示不完整估算。',
    'projection-missing-requests': '插件返回中缺少请求投影列表。',
    'projection-source-unavailable': '读取 dsh-context 现有投影失败。',
    'projection-not-enabled': '该记录生成时未启用 dsh-context 已有数据读取。',
    'invalid-or-unavailable-projection': '投影缺失、版本不兼容或未通过关联校验。',
    'projection-no-previous-request': '插件返回无前次投影请求。',
    'projection-unavailable': '插件未返回可用的相邻投影差异。',
    'projection-delta-not-collected': '分类投影存在，但未记录差异。',
    'projection-base-not-adjacent': '投影基准不是当前已采集列表中的相邻请求，未混用比较范围。',
    'no-previous-captured-request': '当前源会话的已采集列表中没有前次请求；不代表真实会话的首请求。',
    'existing-source-diff-unavailable': '现有数据没有可用的相邻投影差异。第一版不使用新增成员采集回退，数量未知。',
    'both-memberships-unavailable': '前后请求均缺少有效、已绑定的成员清单。',
    'previous-membership-unavailable': '前次请求缺少有效、已绑定的成员清单。',
    'current-membership-unavailable': '当前请求缺少有效、已绑定的成员清单。',
  } : {};
  const reason = (value: string | undefined | null) => value ? reasons[value] ?? value : '';
  const category = (key: string) => zh ? ({'tool-definition':'工具定义','runtime-context':'运行上下文','skill-injection':'Skill 注入','skill-catalog':'Skill 目录',system:'系统提示词',tools:'工具定义',user:'用户消息',inject:'运行上下文',skill:'Skill 注入',assistant:'历史回复',tool:'工具结果'} as Record<string,string>)[key] ?? key : key;
  return <section className="space-y-3" aria-label={zh ? '相邻差异结果' : 'Adjacent difference result'}>
    <h4 className="text-sm font-medium">{result.previous ? `#${result.previous.eventSequence} → #${current.eventSequence}` : `— → #${current.eventSequence}`}</h4>
    <p className="text-xs text-foreground-secondary">{zh ? '数据来源' : 'Source'}: {result.source === 'dsh-context' ? `dsh-context ${current.dshContext?.version} · ${zh ? '投影差异' : 'projected diff'}` : (zh ? '不可比较' : 'Unavailable')}</p>
    {result.source !== 'dsh-context' && <p className="text-xs text-foreground-secondary">{reason(result.projectionReason)}</p>}
    {result.source === 'unavailable' ? <p className="text-sm">{reason(result.reason)}</p> : <>
      <table className="w-full text-left text-xs"><thead><tr><th>{zh ? '分类' : 'Category'}</th><th>+</th><th>−</th><th>Token ↑</th><th>Token ↓</th></tr></thead><tbody>{['system','tools','user','inject','skill','assistant','tool'].map(k => <tr key={k} className="border-t border-border"><td className="py-2">{category(k)}</td><td>{result.projection.addedCounts?.[k] ?? '—'}</td><td>{result.projection.removedCounts?.[k] ?? '—'}</td><td>{result.projection.tokenUp?.[k] ?? '—'}</td><td>{result.projection.tokenDown?.[k] ?? '—'}</td></tr>)}</tbody></table>
      <p className="text-xs text-foreground-secondary">{zh ? '投影节点数量和 Token 估算变化，不是请求成员或正文逐行差异。' : 'Projected nodes and estimated tokens, not membership or line-by-line text differences.'}</p>
    </>}
  </section>;
}
