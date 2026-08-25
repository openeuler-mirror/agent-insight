import { CircleHelp, Sparkles } from 'lucide-react';
import { AGENT_DEBUG_FAULT_MODES } from '@/lib/engine/agent-debug/capabilities';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface AgentDebugCapabilitySheetProps {
  locale: string;
}

export function AgentDebugCapabilitySheet({ locale }: AgentDebugCapabilitySheetProps) {
  const zh = locale === 'zh';

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          title={zh ? '查看支持的故障模式' : 'View supported fault patterns'}
          className="ai-btn-s inline-flex items-center gap-1 px-2 py-1 text-[11px]"
        >
          <CircleHelp className="size-3" />
          {zh ? '能力说明' : 'Capabilities'}
        </button>
      </SheetTrigger>
      <SheetContent className="w-[min(92vw,560px)] gap-0 p-0 sm:max-w-[560px]">
        <SheetHeader className="border-b border-border px-5 py-5 pr-12">
          <div className="mb-1 flex items-center gap-2 text-primary">
            <Sparkles className="size-4" />
            <span className="text-[10.5px] font-bold tracking-[0.14em]">
              {zh ? '智能诊断能力' : 'DIAGNOSIS CAPABILITIES'}
            </span>
          </div>
          <SheetTitle className="text-lg font-extrabold tracking-tight">
            {zh ? '可识别的故障模式' : 'Recognizable fault patterns'}
          </SheetTitle>
          <SheetDescription className="text-[12.5px] leading-6 text-foreground-muted">
            {zh
              ? '智能诊断会结合完整 Trace 中的行为、工具调用和环境反馈，识别以下故障模式。诊断结论均应关联可回溯的执行证据。'
              : 'Diagnosis uses behavior, tool calls, and environment feedback from the full trace to recognize the following fault patterns. Every conclusion should link to traceable execution evidence.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-2">
            {AGENT_DEBUG_FAULT_MODES.map((mode, index) => {
              const copy = zh ? mode.zh : mode.en;
              return (
                <section key={mode.key} className="rounded-lg border border-border bg-card px-3.5 py-3 shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary-subtle-border bg-primary-subtle text-[10.5px] font-bold text-primary">
                      {index + 1}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-bold leading-6 text-foreground">{copy.title}</h3>
                      <p className="mt-0.5 text-[12px] leading-5 text-foreground-muted">{copy.description}</p>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          <div className="mt-4 rounded-lg border border-border bg-background-secondary px-3.5 py-3 text-[12px] leading-5 text-foreground-muted">
            {zh
              ? '对未归入以上类型、但存在明确证据并影响执行结果的问题，智能诊断也会给出说明。'
              : 'Diagnosis can also explain issues outside these patterns when clear evidence shows an impact on the execution result.'}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
