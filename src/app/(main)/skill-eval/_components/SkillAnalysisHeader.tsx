'use client';

/**
 * 复用的"Skills 分析"页头：sa-bar 面包屑 + sa-selector-hifi 选择卡。
 *
 * 主页 /skill-eval 和子页 /skill-eval/trigger/[skillName] 共享同一套外观，
 * 以前是各自 inline 写一份；后者的 Skill 切换器以前是个简陋的 <select>。
 * 抽出来后调用方只描述：面包屑 + skill 列表 + （可选）版本列表 + 右侧 actions。
 *
 * CSS 仍走 skill-analysis.css 里既有的 .sa-bar / .sa-selector / .sa-selector-hifi /
 * .sa-sel-skill / .sa-sel-skill-trigger / .skill-icon 类——本组件不引入新样式，
 * 改起来跟原页面 1:1 等价。
 */

import { Fragment, type ReactNode } from 'react';

export interface BreadcrumbItem {
  label: string;
  /** 不传则纯文本；传了走 <a> 跳转 */
  href?: string;
  onClick?: () => void;
}

export interface SkillOptionLite {
  id: string;
  name: string;
}

export interface VersionOptionLite {
  version: number;
  /** 可选展示用：v3 · 2026-05-19 */
  label?: string;
  isActive?: boolean;
}

export interface SkillAnalysisHeaderProps {
  crumbs: BreadcrumbItem[];
  skills: SkillOptionLite[];
  selectedSkillId: string;
  onSelectSkill: (skillId: string) => void;
  skillsLoading?: boolean;
  /** 用来在选择器左侧显示 monogram。不传则用 selectedSkillId 对应 skill 的 name 推。 */
  monogram?: string;
  /** 不传 versions 时整个版本选择器隐藏（触发评价集页就用这个模式）。 */
  versions?: VersionOptionLite[];
  selectedVersion?: number | null;
  /** number 表示具体版本；null 表示"全部版本"（不按版本过滤） */
  onSelectVersion?: (version: number | null) => void;
  /** 右侧 actions slot，比如"发起新分析"、"AI 重新起草"、模型选择器等。 */
  actions?: ReactNode;
}

function defaultMonogram(name?: string) {
  const cleaned = (name || '').trim();
  if (!cleaned) return 'SK';
  const ascii = cleaned.replace(/[^a-zA-Z0-9]/g, '');
  if (ascii.length >= 2) return ascii.slice(0, 2).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
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
  const monogramText = monogram ?? defaultMonogram(selectedSkill?.name);

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

      <section className="sa-selector sa-selector-hifi" aria-label="选择skill">
        <label className="sa-sel-skill">
          <span>Skill</span>
          <div className="sa-sel-skill-trigger">
            <span className="skill-icon">{monogramText}</span>
            <select
              value={selectedSkillId}
              onChange={e => onSelectSkill(e.target.value)}
              disabled={skillsLoading}
              aria-label="切换 Skill"
            >
              {skills.length === 0 && <option value="">暂无 Skill</option>}
              {skills.map(skill => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          </div>
        </label>

        {showVersion && (
          <label>
            <span>版本</span>
            <select
              // value="" 表示"全部版本"——null 在 <select> 里不能直接当 value，统一用 ''
              value={selectedVersion ?? ''}
              onChange={e => {
                const raw = e.target.value;
                onSelectVersion?.(raw === '' ? null : Number(raw));
              }}
              disabled={!selectedSkill || (versions?.length ?? 0) === 0}
            >
              <option value="">全部</option>
              {(versions?.length ?? 0) === 0 && selectedVersion != null && (
                <option value={selectedVersion}>v{selectedVersion}</option>
              )}
              {versions?.map(v => (
                <option key={v.version} value={v.version}>
                  {v.label ?? `v${v.version}${v.isActive ? '（当前）' : ''}`}
                </option>
              ))}
            </select>
          </label>
        )}

        <span className="spacer" />
        {actions}
      </section>
    </>
  );
}
