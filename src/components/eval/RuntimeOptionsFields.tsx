import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { optionsToInputs, type RuntimeDefinition, type RuntimeOptionInputs } from '@/lib/engine/experiment/runtime-options'

export function RuntimeOptionsFields({ definition, value, error, onChange }: {
  definition: RuntimeDefinition
  value: RuntimeOptionInputs
  error: string | null
  onChange: (value: RuntimeOptionInputs) => void
}) {
  return <section className="mb-4 grid gap-3" aria-label={`${definition.displayName} 运行参数`}>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{definition.displayName} 运行参数</h3>
      {definition.presets.map(preset => <Button key={preset.key} type="button" variant="outline" size="sm"
        onClick={() => onChange(optionsToInputs(definition, { runtimeKey: definition.runtimeKey,
          definitionDigest: definition.definitionDigest, values: preset.values }))}>{preset.label}</Button>)}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(optionsToInputs(definition))}>恢复默认</Button>
    </div>
    {definition.parameterGroups.map(group => <div key={group.key} className="grid gap-3">
      <h4 className="text-sm font-semibold">{group.label}</h4>
      {group.description && <p className="text-xs text-foreground-muted">{group.description}</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {definition.parameters.filter(field => field.group === group.key).map(field => <label key={field.key} className="grid gap-1 text-xs">
          {field.label}
          {field.type === 'boolean' || field.type === 'enum' ? <select className="h-9 w-full min-w-0 rounded-md border border-card-border bg-background px-3 py-1 text-sm text-foreground shadow-xs outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20" aria-label={field.label}
            value={value[field.key] ?? ''} required={field.required}
            onChange={event => onChange({ ...value, [field.key]: event.target.value })}>
            <option value="">请选择</option>
            {(field.type === 'boolean' ? [true, false] : field.choices || []).map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
          </select> : <Input className="border-card-border placeholder:text-foreground-muted focus-visible:border-primary focus-visible:ring-primary/20"
            type={field.type === 'string' ? 'text' : 'number'} min={field.minimum} max={field.maximum}
            minLength={field.minLength} maxLength={field.maxLength} step={field.type === 'integer' ? 1 : 'any'}
            required={field.required} aria-label={field.label} value={value[field.key] ?? ''}
            onChange={event => onChange({ ...value, [field.key]: event.target.value })} />}
          {field.description && <span className="text-foreground-muted">{field.description}</span>}
        </label>)}
      </div>
    </div>)}
    {error && <p className="text-sm text-error" role="alert">{error}</p>}
  </section>
}
