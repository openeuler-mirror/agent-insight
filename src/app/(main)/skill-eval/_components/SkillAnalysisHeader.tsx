'use client';

/**
 * Skills 分析 — header-context strip
 *
 * 依据 docs/design/patterns.md §A.5.3 `detail-object` 变体 + 原型
 * refs/ui-2026-05/.../agent-insight-prototype-统一导航栏和skill选项.html
 * `data-page="analysis"` 的 .header-context 段落。
 *
 * 早期版本是个"大表单卡"（.sa-selector-hifi —— bordered + shadow + 14×18 padding
 * + 两个 stacked label/select 列），与设计语言里轻量 header-context 不匹配。
 * 现在改成扁平 chrome：32×32 mono 字母图标 + 15px mono skill 名 + chev 下拉，
 * 副行 11px muted 放版本 chip。selects 仍为原生 <select>，零依赖、可访问、
 * 键盘可达；样式见 skill-analysis.css 末尾的 `.sa-context-bar` 段。
 *
 * 注：crumbs 仍支持（设计 row-1），但当 AppTopBar 已经渲染同名标题时调用方传
 * 空数组即可，不会再渲染冗余面包屑。
 */

import { Fragment, type ReactNode } from 'react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface SkillOptionLite {
  id: string;
  name: string;
}

export interface VersionOptionLite {
  version: number;
  label?: string;
  isActive?: boolean;
}

export interface SkillAnalysisHeaderProps {
  crumbs: BreadcrumbItem[];
  skills: SkillOptionLite[];
  selectedSkillId: string;
  onSelectSkill: (skillId: string) => void;
  skillsLoading?: boolean;
  monogram?: string;
  versions?: VersionOptionLite[];
  selectedVersion?: number | null;
  onSelectVersion?: (version: number | null) => void;
  actions?: ReactNode;
}

function defaultMonogram(name?: string) {
  const cleaned = (name || '').trim();
  if (!cleaned) return 'SK';
  const ascii = cleaned.replace(/[^a-zA-Z0-9]/g, '');
  if (ascii.length >= 2) return ascii.slice(0, 2).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

// 12×12 chevron-down,inherit currentColor —— 不引入 lucide-react 依赖；
// 这里只是个装饰图标，inline svg 足够。
function ChevDown({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function SkillAnalysisHeader({
  crumbs,
  skills,
  selectedSkillId,
  onSelectSkill,
  skillsLoading = false,
  monogram,
  versions,
  selectedVersion,
  onSelectVersion,
  actions,
}: SkillAnalysisHeaderProps) {
  const selectedSkill = skills.find(s => s.id === selectedSkillId);
  const showVersion = Array.isArray(versions);
  const monogramText = (monogram ?? defaultMonogram(selectedSkill?.name)).slice(0, 2);
  const hasSkills = skills.length > 0;

  return (
    <>
      {crumbs.length > 0 && (
        <nav className="sa-bar" aria-label="面包屑">
          {crumbs.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {c.href || c.onClick ? (
                <a
                  href={c.href ?? '#'}
                  onClick={e => {
                    if (c.onClick) {
                      e.preventDefault();
                      c.onClick();
                    }
                  }}
                >
                  {c.label}
                </a>
              ) : (
                <span>{c.label}</span>
              )}
            </Fragment>
          ))}
        </nav>
      )}

      <section className="sa-context-bar" aria-label="选择skill">
        <div className="sa-context-icon" aria-hidden="true">{monogramText}</div>
        <div className="sa-context-body">
          <div className="sa-context-title">
            <span className="sa-sr-only">Skill</span>
            <select
              value={selectedSkillId}
              onChange={e => onSelectSkill(e.target.value)}
              disabled={skillsLoading || !hasSkills}
              aria-label="切换 Skill"
            >
              {!hasSkills && <option value="">暂无 Skill</option>}
              {skills.map(skill => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
            <ChevDown className="sa-context-chev" />
          </div>

          {showVersion && (
            <div className="sa-context-sub">
              <label className="sa-context-version">
                <span className="sa-sr-only">版本</span>
                <select
                  value={selectedVersion ?? ''}
                  onChange={e => {
                    const raw = e.target.value;
                    onSelectVersion?.(raw === '' ? null : Number(raw));
                  }}
                  disabled={!selectedSkill || (versions?.length ?? 0) === 0}
                >
                  <option value="">全部版本</option>
                  {(versions?.length ?? 0) === 0 && selectedVersion != null && (
                    <option value={selectedVersion}>v{selectedVersion}</option>
                  )}
                  {versions?.map(v => (
                    <option key={v.version} value={v.version}>
                      {v.label ?? `v${v.version}${v.isActive ? '（当前）' : ''}`}
                    </option>
                  ))}
                </select>
                <ChevDown className="sa-context-chev" />
              </label>
            </div>
          )}
        </div>

        <span className="sa-context-spacer" />
        {actions && <div className="sa-context-actions">{actions}</div>}
      </section>
    </>
  );
}
