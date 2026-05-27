'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { useTheme } from '@/lib/client/theme-context';

interface SkillLinkProps {
  skillId?: string | null;
  skillName: string;
  version?: string | number | null;
  user?: string | null;
  /**
   * 未被平台管理的 skill 传 true：渲染成灰色不可点击的文本 + tooltip 提示。
   * 用在 trace 详情 Skills 页签里 status==='unregistered' 的卡片上，避免跳到 skill-detail
   * 看到 not-found 空页。默认 false 保留所有现有调用方行为。
   */
  disabled?: boolean;
}

export function SkillLink({ skillId, skillName, version, user, disabled = false }: SkillLinkProps) {
  const router = useRouter();
  const { isDark } = useTheme();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();

    // 有 skillId → 跳 skill 管理 /skills 并通过 query 让 SkillCatalogV2 自动打开对应抽屉
    // (旧实现跳 /skill-detail?id=... 依赖一个不存在的 /api/skills/[id] GET 路由,必然 404)。
    // 没 skillId (从 Dashboard / details 旧记录里只有 name 的情况) 维持旧 /skill-detail?name=...
    // 行为不变, by-name 接口存在,这两条调用路径之前就能用。
    if (skillId) {
      const params = new URLSearchParams({ openSkillId: skillId });
      if (version !== null && version !== undefined) {
        params.set('openVersion', String(version));
      }
      router.push(`/skills?${params.toString()}`);
      return;
    }

    const params = new URLSearchParams({ name: skillName });
    if (user) params.set('user', user);
    if (version !== null && version !== undefined) {
      params.set('version', String(version));
    }
    router.push(`/skill-detail?${params.toString()}`);
  };

  if (!skillId && !skillName) {
    return <span style={{ color: isDark ? '#71717a' : '#a1a1aa' }}>(None)</span>;
  }

  const label = `${skillName}${version !== null && version !== undefined ? ` (v${version})` : ''}`;

  if (disabled) {
    return (
      <span
        title="该 Skill 未被平台管理，无法跳转到详情"
        style={{
          color: isDark ? '#71717a' : '#a1a1aa',
          cursor: 'not-allowed',
          textDecoration: 'none',
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      onClick={handleClick}
      style={{
        color: isDark ? '#60a5fa' : '#2563eb',
        cursor: 'pointer',
        textDecoration: 'none',
        transition: 'color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'underline';
        e.currentTarget.style.color = isDark ? '#93c5fd' : '#2563eb';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none';
        e.currentTarget.style.color = isDark ? '#60a5fa' : '#2563eb';
      }}
    >
      {label}
    </span>
  );
}

interface SkillLinksProps {
  skills?: string[];
  skill?: string;
  skillId?: string | null;
  skillIds?: string[];
  skillVersion?: number | null;
  user?: string | null;
}

export function SkillLinks({ 
  skills, 
  skill, 
  skillId, 
  skillIds, 
  skillVersion, 
  user 
}: SkillLinksProps) {
  const { isDark } = useTheme();

  if (!skills?.length && !skill) {
    return <span style={{ color: isDark ? '#71717a' : '#a1a1aa' }}>(None)</span>;
  }

  if (skills?.length) {
    return (
      <>
        {skills.map((s, index) => {
          const sId = skillIds?.[index] || null;
          return (
            <React.Fragment key={index}>
              {index > 0 && <span style={{ color: isDark ? '#3f3f46' : '#d4d4d8' }}>, </span>}
              <SkillLink
                skillId={sId}
                skillName={s}
                version={skillVersion}
                user={user}
              />
            </React.Fragment>
          );
        })}
      </>
    );
  }

  return (
    <SkillLink
      skillId={skillId}
      skillName={skill!}
      version={skillVersion}
      user={user}
    />
  );
}
