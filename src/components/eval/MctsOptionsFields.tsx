import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MCTS_DEFAULT_OPTIONS, MCTS_OPTION_FIELDS, MCTS_QUICK_OPTIONS, mctsOptionsToInputs, type MctsOptionInputs } from '@/lib/engine/experiment/mcts-options'

export function MctsOptionsFields({ value, error, onChange }: {
  value: MctsOptionInputs
  error: string | null
  onChange: (value: MctsOptionInputs) => void
}) {
  return <section className="mb-4 grid gap-3" aria-label="MCTS 搜索参数">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">MCTS 搜索参数</h3>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(mctsOptionsToInputs({ mcts: MCTS_QUICK_OPTIONS }))}>填入联调参数</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(mctsOptionsToInputs(undefined))}>恢复默认</Button>
    </div>
    <p className="text-xs text-foreground-muted">已填入 MCTS 默认值，可直接调整。Token 熔断阈值为 0 时关闭熔断；Agent 超时独立生效。</p>
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
      {MCTS_OPTION_FIELDS.map(field => <label key={field.key} className="grid gap-1 text-xs">
        {field.label}
        <Input className="border-card-border placeholder:text-foreground-muted focus-visible:border-primary focus-visible:ring-primary/20"
          type="number" min={field.min} step={1} required aria-label={field.label}
          value={value[field.key] ?? String(MCTS_DEFAULT_OPTIONS[field.key])}
          onChange={event => onChange({ ...value, [field.key]: event.target.value })} />
      </label>)}
    </div>
    {error && <p className="text-sm text-error" role="alert">{error}</p>}
  </section>
}
