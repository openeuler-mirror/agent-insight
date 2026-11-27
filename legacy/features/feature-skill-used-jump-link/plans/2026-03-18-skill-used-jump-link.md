# Skill Used Jump Link Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add click-to-navigate functionality from skill names in execution records to a dedicated skill detail page.

**Architecture:** Create SkillLink component for styled clickable skill names, skill detail page that can accept either skill ID or name, and modify execution record displays to use SkillLink component.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/components/SkillLink.tsx` | Create | Clickable skill name component |
| `src/app/skills/page.tsx` | Create | Skill detail page (handles ID or name lookup) |
| `src/app/api/skills/by-name/route.ts` | Create | API to find skill by exact name |
| `src/app/details/page.tsx:1995-1998` | Modify | Replace skill text with SkillLink |
| `src/components/Dashboard.tsx:2559-2561` | Modify | Replace skill text with SkillLink |

---

## Chunk 1: API for Skill Lookup by Name

### Task 1.1: Create API to find skill by name

**Files:**
- Create: `src/app/api/skills/by-name/route.ts`

- [ ] **Step 1: Write the API endpoint**

```typescript
import { resolveUser } from '@/lib/auth';
import { db } from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const name = searchParams.get('name');
    const userParam = searchParams.get('user');

    if (!name) {
      return NextResponse.json({ error: 'Name parameter required' }, { status: 400 });
    }

    const { username: user } = await resolveUser(request, userParam);

    const where: any = {
      name: name
    };

    if (user) {
      where.OR = [
        { user: user },
        { user: null },
        { visibility: 'public' }
      ];
    }

    const skills = await db.findSkills(where);
    const skill = skills[0];

    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      activeVersion: skill.activeVersion || 0
    });
  } catch (error) {
    console.error('Find Skill By Name Error:', error);
    return NextResponse.json({ error: 'Failed to find skill' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Test the API manually**

Run: `curl "http://localhost:3000/api/skills/by-name?name=<existing_skill_name>"`
Expected: Returns skill JSON with id, name, description
Expected: Returns 404 for non-existent skill

- [ ] **Step 3: Commit**

```bash
git add src/app/api/skills/by-name/route.ts
git commit -m "feat: add API to find skill by exact name"
```

---

## Chunk 2: SkillLink Component

### Task 2.1: Create SkillLink component

**Files:**
- Create: `src/components/SkillLink.tsx`

- [ ] **Step 1: Write the SkillLink component**

```typescript
'use client';

import { useRouter } from 'next/navigation';
import React from 'react';

interface SkillLinkProps {
  skillId?: string | null;
  skillName: string;
  version?: string | number | null;
  user?: string | null;
}

export function SkillLink({ skillId, skillName, version, user }: SkillLinkProps) {
  const router = useRouter();

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
    
    router.push(`/skills?${params.toString()}`);
  };

  if (!skillId && !skillName) {
    return <span style={{ color: '#64748b' }}>(None)</span>;
  }

  return (
    <span
      onClick={handleClick}
      style={{
        color: '#60a5fa',
        cursor: 'pointer',
        textDecoration: 'none',
        transition: 'color 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'underline';
        e.currentTarget.style.color = '#93c5fd';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none';
        e.currentTarget.style.color = '#60a5fa';
      }}
    >
      {skillName}{version ? ` (v${version})` : ''}
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
  if (!skills?.length && !skill) {
    return <span style={{ color: '#64748b' }}>(None)</span>;
  }

  if (skills?.length) {
    return (
      <>
        {skills.map((s, index) => {
          const sId = skillIds?.[index] || null;
          return (
            <React.Fragment key={index}>
              {index > 0 && <span style={{ color: '#e2e8f0' }}>, </span>}
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SkillLink.tsx
git commit -m "feat: add SkillLink component for clickable skill names"
```

---

## Chunk 3: Skill Detail Page

### Task 3.1: Create skill detail page

**Files:**
- Create: `src/app/skills/page.tsx`

- [ ] **Step 1: Write the skill detail page**

```typescript
'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface SkillData {
  id: string;
  name: string;
  description?: string;
  category?: string;
  activeVersion: number;
}

interface SkillVersionData {
  version: number;
  content: string;
  changeLog?: string;
  createdAt: string;
}

export default function SkillDetailPage() {
  const searchParams = useSearchParams();
  const skillId = searchParams.get('id');
  const skillName = searchParams.get('name');
  const user = searchParams.get('user') || undefined;
  const version = searchParams.get('version');

  const [skill, setSkill] = useState<SkillData | null>(null);
  const [skillVersion, setSkillVersion] = useState<SkillVersionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSkill() {
      setLoading(true);
      setError(null);

      try {
        let skillData: SkillData | null = null;

        if (skillId) {
          const res = await fetch(`/api/skills/${skillId}`);
          if (res.ok) {
            skillData = await res.json();
          }
        } else if (skillName) {
          const params = new URLSearchParams({ name: skillName });
          if (user) params.set('user', user);
          const res = await fetch(`/api/skills/by-name?${params}`);
          if (res.ok) {
            skillData = await res.json();
          }
        }

        if (!skillData) {
          setError('Skill not found');
          setLoading(false);
          return;
        }

        setSkill(skillData);

        const versionNum = version ? parseInt(version, 10) : skillData.activeVersion;
        const verRes = await fetch(`/api/skills/${skillData.id}/versions/${versionNum}`);
        if (verRes.ok) {
          setSkillVersion(await verRes.json());
        }
      } catch (err) {
        setError('Failed to load skill');
      }

      setLoading(false);
    }

    fetchSkill();
  }, [skillId, skillName, user, version]);

  if (loading) {
    return (
      <div style={{ padding: '2rem', color: '#e2e8f0' }}>
        <p>Loading skill...</p>
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div style={{ padding: '2rem', color: '#e2e8f0' }}>
        <Link href="/" style={{ color: '#60a5fa', marginBottom: '1rem', display: 'inline-block' }}>
          ← Back to Dashboard
        </Link>
        <h1 style={{ color: '#f87171' }}>Skill Not Found</h1>
        <p style={{ color: '#94a3b8' }}>
          {error || 'The requested skill could not be found. It may have been deleted.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', color: '#e2e8f0', maxWidth: '1200px', margin: '0 auto' }}>
      <Link href="/" style={{ color: '#60a5fa', marginBottom: '1rem', display: 'inline-block' }}>
        ← Back to Dashboard
      </Link>

      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
          {skill.name}
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
          Category: {skill.category || 'Other'} | Version: {version || skill.activeVersion}
        </p>
      </div>

      {skill.description && (
        <div style={{ marginBottom: '2rem', padding: '1rem', background: '#1e293b', borderRadius: '8px' }}>
          <h3 style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Description</h3>
          <p>{skill.description}</p>
        </div>
      )}

      {skillVersion?.changeLog && (
        <div style={{ marginBottom: '2rem', padding: '1rem', background: '#1e293b', borderRadius: '8px' }}>
          <h3 style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Change Log</h3>
          <p>{skillVersion.changeLog}</p>
        </div>
      )}

      {skillVersion?.content && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Skill Content</h3>
          <pre style={{ 
            padding: '1rem', 
            background: '#0f172a', 
            borderRadius: '8px', 
            overflow: 'auto',
            fontSize: '0.85rem',
            whiteSpace: 'pre-wrap'
          }}>
            {skillVersion.content}
          </pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/skills/page.tsx
git commit -m "feat: add skill detail page with name/ID lookup support"
```

---

## Chunk 4: Update Details Page

### Task 4.1: Modify details page to use SkillLink

**Files:**
- Modify: `src/app/details/page.tsx:1991-1999`

- [ ] **Step 1: Add import for SkillLinks**

Find the imports section and add:
```typescript
import { SkillLinks } from '@/components/SkillLink';
```

- [ ] **Step 2: Replace skill used display**

Find lines 1991-1999 and replace with:
```tsx
{/* 1. Skills Used */}
<div style={{ marginBottom: '2rem' }}>
    <h4 style={sectionHeader}>Skills Used</h4>
    <div style={{ ...codeBlock, padding: '0.5rem', background: '#1e293b', borderRadius: '4px', border: '1px solid #334155' }}>
        <SkillLinks
            skills={item.skills}
            skill={item.skill}
            skillVersion={item.skill_version}
            user={item.user}
        />
    </div>
</div>
```

- [ ] **Step 3: Verify changes compile**

Run: `npm run build`
Expected: Build succeeds without errors

- [ ] **Step 4: Commit**

```bash
git add src/app/details/page.tsx
git commit -m "feat: use SkillLinks in details page for clickable skills"
```

---

## Chunk 5: Update Dashboard

### Task 5.1: Modify Dashboard to use SkillLink

**Files:**
- Modify: `src/components/Dashboard.tsx:2556-2563`

- [ ] **Step 1: Add import for SkillLinks**

Find the imports section and add:
```typescript
import { SkillLinks } from './SkillLink';
```

- [ ] **Step 2: Replace skill used display**

Find lines 2556-2563 and replace with:
```tsx
<div className="detail-row">
    <strong style={{ display: 'block', marginBottom: '0.2rem', color: '#94a3b8' }}>Skills Used:</strong>
    <div className="code-block">
        <SkillLinks
            skills={selectedRecord.skills}
            skill={selectedRecord.skill}
            skillVersion={selectedRecord.skill_version}
            user={selectedRecord.user}
        />
    </div>
</div>
```

- [ ] **Step 3: Verify changes compile**

Run: `npm run build`
Expected: Build succeeds without errors

- [ ] **Step 4: Commit**

```bash
git add src/components/Dashboard.tsx
git commit -m "feat: use SkillLinks in Dashboard for clickable skills"
```

---

## Chunk 6: Verification

### Task 6.1: Verify all functionality works

- [ ] **Step 1: Run development server**

Run: `npm run dev`
Expected: Server starts without errors

- [ ] **Step 2: Manual verification checklist**

1. Navigate to execution details page - verify skill names are blue and clickable
2. Click a skill name - verify navigation to skill detail page
3. Verify skill detail page shows correct skill info
4. Verify back navigation works
5. Test with execution that has multiple skills
6. Test with execution that has no skill (should show "(None)")
7. Test with deleted skill (should show "Skill Not Found")

- [ ] **Step 3: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: any issues found during verification"
```

---

## Summary

| Task | Description | Status |
|------|-------------|--------|
| 1.1 | Create API for skill lookup by name | [ ] |
| 2.1 | Create SkillLink component | [ ] |
| 3.1 | Create skill detail page | [ ] |
| 4.1 | Update details page | [ ] |
| 5.1 | Update Dashboard | [ ] |
| 6.1 | Verify all functionality | [ ] |
