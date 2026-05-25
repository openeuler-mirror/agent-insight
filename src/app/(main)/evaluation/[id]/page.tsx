'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useThemeColors } from '@/lib/client/theme-context';

/**
 * /evaluation/<id> 路由现在只做一件事：拉一次 evaluation meta 拿到 skillName + version，
 * 立刻 router.replace 到 /skill-eval?...&view=static&evalId=<id>。
 *
 * 评估详情统一收口在 skill-eval 静态视图（含维度评分 + 完整优化点 + 一键评估等）。
 * 旧链接（邮件/Slack 里的 /evaluation/xxx）直接转过去，对用户无感。
 */
export default function EvaluationDetailPage() {
    const c = useThemeColors();
    const router = useRouter();
    const params = useParams<{ id: string }>();
    const evaluationId = params?.id;

    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!evaluationId) return;
        let cancelled = false;
        fetch(`/api/evaluation/${encodeURIComponent(evaluationId)}`)
            .then(async r => {
                if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
                return r.json();
            })
            .then((d: { evaluation: { skillName: string | null; version: number } }) => {
                if (cancelled) return;
                const skill = d.evaluation.skillName;
                const version = d.evaluation.version;
                if (!skill) {
                    setError('该评估缺少 skillName，无法跳转到 Skill 评估工作台。');
                    return;
                }
                // replace 而非 push：旧 URL 不进 history，浏览器返回键不会卡在这一步
                // 注：skill-eval 当前仅展示该 skillVersion 的 latest 评估；如果旧链接指向更早的 evaluation，
                // 跳过去看到的就是最新版本（暂未支持 evalId 历史选择，留作后续增强）。
                router.replace(`/skill-eval?skill=${encodeURIComponent(skill)}&version=${version}&view=static`);
            })
            .catch(e => {
                if (cancelled) return;
                setError(e?.message || String(e));
            });
        return () => { cancelled = true; };
    }, [evaluationId, router]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: c.bg }}>
            <AppTopBar title="评估详情" />
            <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem 2rem' }}>
                {!error && <div style={{ color: c.fgSecondary }}>正在跳转到 Skill 评估工作台…</div>}
                {error && (
                    <div style={{ background: '#fef2f2', color: '#991b1b', padding: '1rem', borderRadius: 8 }}>
                        加载失败：{error}
                    </div>
                )}
            </div>
        </div>
    );
}
