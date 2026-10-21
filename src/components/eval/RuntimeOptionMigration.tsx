import { Button } from '@/components/ui/button'
import type { OptionMigration } from '../../../packages/agent-runtime/option-migration.cjs'

export function RuntimeOptionMigration({ migration, onConfirm }: { migration: OptionMigration; onConfirm: () => void }) {
  return <div className="mb-3 grid gap-3 rounded-lg border border-card-border bg-background-secondary p-3">
    <div className="grid gap-1">
      <p className="text-sm font-semibold">旧参数转换预览</p>
      <p className="text-xs text-foreground-muted">以下历史别名将改为执行端 CLI 原名，参数值保持原样。确认仅用于新实验，原实验快照不变。</p>
    </div>
    <div className="overflow-auto rounded-md border border-card-border bg-background">
      <table className="w-full text-left text-xs">
        <thead><tr className="border-b border-card-border text-foreground-muted"><th className="p-2">历史 Key</th><th className="p-2">执行端 Key</th><th className="p-2">原值</th></tr></thead>
        <tbody>{migration.changes.map(change => <tr key={change.from} className="border-b border-card-border last:border-0">
          <td className="p-2 font-mono">{change.from}</td><td className="p-2 font-mono">{change.to}</td><td className="p-2 font-mono">{JSON.stringify(change.value)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div><Button type="button" size="sm" onClick={onConfirm}>确认转换并用于新实验</Button></div>
  </div>
}
