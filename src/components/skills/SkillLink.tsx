'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { useTheme } from '@/lib/client/theme-context';

interface SkillLinkProps {
  skillId?: string | null;
  skillName: string;
  version?: string | number | null;
  user?: string | null;
}

export function SkillLink({ skillId, skillName, version, user }: SkillLinkProps) {
  const router = useRouter();
  const { isDark } = useTheme();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    
    const params = new URLSearchParams();
    if (skillId) {
      params.set('id', skillId);
    } else {
      params.set('name', skillName);
      if (user) params.set('user', user);
    }
    if (version !== null && version !== undefined) {
      params.set('version', String(version));
    }
    
    router.push(`/skill-detail?${params.toString()}`);
  };

  if (!skillId && !skillName) {
    return <span style={{ color: isDark ? '#71717a' : '#a1a1aa' }}>(None)</span>;
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
      {skillName}{version !== null && version !== undefined ? ` (v${version})` : ''}
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
