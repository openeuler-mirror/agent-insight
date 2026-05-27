'use client';

/**
 * Skill 管理 —— 头部对齐 /skill-eval（Skill 分析）：
 *   1. 顶部用 <AppTopBar title="Skill 管理" />（与 Skill 分析、Skill 优化等子模块一致）
 *   2. 内容区第一行是一个单行 selector toolbar（标题块 + 搜索 + 筛选 + inline 统计 + 上传按钮），
 *      取代之前的"badge + h1 + button + 描述 + 4 卡 KPI strip + 单独筛选行"那一坨纵向占位。
 *
 * 注：toolbar 由 SkillCatalogV2 内部渲染（拿得到 stats / search / filter / 上传回调），
 * 这一层只负责挂 AppTopBar + 触发上传 modal。
 */
import { Suspense, useEffect, useState, type ComponentType } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { SkillCatalog, SkillUpload, SkillGenerate, EnterpriseSync } from '@/components/skills/SkillRegistry';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Check, FolderUp, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/client/api';

export default function SkillsPage() {
    return (
        <Suspense fallback={null}>
            <SkillsPageInner />
        </Suspense>
    );
}

function SkillsPageInner() {
    const [refreshKey, setRefreshKey] = useState(0);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [isEnterpriseMode, setIsEnterpriseMode] = useState(false);

    useEffect(() => {
        apiFetch('/api/eval/config/status?check_org=true')
            .then(res => res.json())
            .then(data => setIsEnterpriseMode(!!data.org_mode))
            .catch(() => undefined);
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)', overflow: 'hidden' }}>
            <AppTopBar title="Skill 管理" showDefaultActions={false} />
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 20px 24px', width: '100%', boxSizing: 'border-box' }}>
                <SkillCatalog refresh={refreshKey} onUploadClick={() => setUploadOpen(true)} />
            </div>

            <SkillCreateDialog
                open={uploadOpen}
                onOpenChange={setUploadOpen}
                isEnterpriseMode={isEnterpriseMode}
                onSuccess={() => {
                    setRefreshKey(k => k + 1);
                    setUploadOpen(false);
                }}
            />
        </div>
    );
}

type CreateMethod = 'upload' | 'generate' | 'sync';

interface MethodSpec {
    id: CreateMethod;
    icon: LucideIcon;
    title: string;
    desc: string;
}

function SkillCreateDialog({
    open,
    onOpenChange,
    isEnterpriseMode,
    onSuccess,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isEnterpriseMode: boolean;
    onSuccess: () => void;
}) {
    const [method, setMethod] = useState<CreateMethod>('upload');

    // 每次打开重置到默认（最常用的本地上传），避免上次留下的选择影响判断
    useEffect(() => {
        if (open) setMethod('upload');
    }, [open]);

    const methods: MethodSpec[] = [
        { id: 'upload', icon: FolderUp, title: '本地上传', desc: '从电脑选择 Skill 文件夹' },
        { id: 'generate', icon: Sparkles, title: 'AI 生成', desc: '用自然语言描述需求，由 AI 生成' },
        ...(isEnterpriseMode
            ? [{ id: 'sync' as const, icon: RefreshCw, title: '企业同步', desc: '从企业 Skill 市场拉取' }]
            : []),
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
                <DialogHeader className="border-b border-border px-5 py-4">
                    <DialogTitle>新建 Skill</DialogTitle>
                    <DialogDescription>
                        选择一种方式来创建新的 Skill。
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 overflow-y-auto bg-background-secondary px-5 py-4">
                    {/* Step 1: picker */}
                    <div
                        role="radiogroup"
                        aria-label="新建 Skill 的方式"
                        className={cn(
                            'grid gap-2',
                            isEnterpriseMode ? 'grid-cols-3' : 'grid-cols-2',
                        )}
                    >
                        {methods.map(m => (
                            <MethodPickerTile
                                key={m.id}
                                icon={m.icon}
                                title={m.title}
                                desc={m.desc}
                                selected={method === m.id}
                                onSelect={() => setMethod(m.id)}
                            />
                        ))}
                    </div>

                    {/* Step 2: action panel for selected method */}
                    <div className="rounded-lg border border-border bg-card px-4 py-4">
                        {method === 'upload' && <SkillUpload onSuccess={onSuccess} />}
                        {method === 'generate' && (
                            <SkillGenerate onNavigate={() => onOpenChange(false)} />
                        )}
                        {method === 'sync' && isEnterpriseMode && (
                            <EnterpriseSync onSuccess={onSuccess} />
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function MethodPickerTile({
    icon: Icon,
    title,
    desc,
    selected,
    onSelect,
}: {
    icon: ComponentType<{ className?: string }>;
    title: string;
    desc: string;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={onSelect}
            className={cn(
                'group relative flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                    ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                    : 'border-border bg-card hover:border-foreground-muted',
            )}
        >
            <div className="flex w-full items-center justify-between">
                <span
                    className={cn(
                        'grid size-8 place-items-center rounded-md transition-colors',
                        selected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-primary-subtle text-primary',
                    )}
                >
                    <Icon className="size-4" />
                </span>
                {selected && <Check className="size-4 text-primary" />}
            </div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="text-xs text-foreground-secondary">{desc}</div>
        </button>
    );
}
