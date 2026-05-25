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
import { useEffect, useState } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { SkillCatalog, SkillUpload, EnterpriseSync } from '@/components/skills/SkillRegistry';
import { apiFetch } from '@/lib/client/api';
import { X } from 'lucide-react';

export default function SkillsPage() {
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

            {uploadOpen && (
                <SkillUploadDialog
                    isEnterpriseMode={isEnterpriseMode}
                    onClose={() => setUploadOpen(false)}
                    onSuccess={() => {
                        setRefreshKey(k => k + 1);
                        setUploadOpen(false);
                    }}
                />
            )}
        </div>
    );
}

function SkillUploadDialog({
    isEnterpriseMode,
    onClose,
    onSuccess,
}: {
    isEnterpriseMode: boolean;
    onClose: () => void;
    onSuccess: () => void;
}) {
    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.48)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                padding: 20,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
                    maxWidth: isEnterpriseMode ? 860 : 560,
                    width: '100%',
                    maxHeight: '90vh',
                    overflow: 'hidden',
                    position: 'relative',
                }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, padding: '18px 20px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--foreground)' }}>上传 Skill</h3>
                        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--foreground-muted)' }}>导入本地 Skill 文件夹，或在企业模式下同步团队 Skill。</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            width: 32,
                            height: 32,
                            display: 'grid',
                            placeItems: 'center',
                            background: 'var(--background-secondary)',
                            border: 'none',
                            borderRadius: 8,
                            color: 'var(--foreground-secondary)',
                            cursor: 'pointer',
                            padding: 0,
                            flexShrink: 0,
                        }}
                        aria-label="关闭"
                    >
                        <X size={16} />
                    </button>
                </div>
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: isEnterpriseMode ? 'repeat(auto-fit, minmax(300px, 1fr))' : '1fr',
                        gap: 16,
                        padding: 20,
                        maxHeight: 'calc(90vh - 74px)',
                        overflowY: 'auto',
                        background: 'var(--background)',
                    }}
                >
                    <SkillUpload onSuccess={onSuccess} />
                    {isEnterpriseMode && <EnterpriseSync onSuccess={onSuccess} />}
                </div>
            </div>
        </div>
    );
}
