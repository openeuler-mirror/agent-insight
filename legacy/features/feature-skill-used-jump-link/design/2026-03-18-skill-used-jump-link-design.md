# Design: Skill Used Jump Link Feature

**Issue**: #52  
**Date**: 2026-03-18  
**Status**: Design Approved

## Overview

Add click-to-navigate functionality to the "skill used" field in execution records, allowing users to click skill names and navigate to a dedicated skill detail page.

## Requirements

1. Clickable skill names in execution records
2. Visual link styling (color, underline, hover effects)
3. Navigate to skill detail page with specific version
4. Support multiple skills in one record
5. Graceful error handling for deleted/non-existent skills

## Architecture

```
Execution Records (details/page.tsx)
        │
        │ click skill name
        ▼
/skills/[id]?version=[version]  ← New Page
        │
        ▼
SkillDetailPage
  - Skill metadata (name, description, version)
  - Flow diagram (Mermaid)
  - Back navigation
```

## Components

### 1. SkillLink Component

**Path**: `/src/components/SkillLink.tsx`

```typescript
interface SkillLinkProps {
  skillId: string | null | undefined;
  skillName: string;
  version?: string | number;
}
```

**Features**:
- Styled as clickable link (blue color, underline on hover)
- Navigates to `/skills/{skillId}?version={version}`
- Falls back to plain text if skillId missing
- Shows tooltip for missing skillId

### 2. Skill Detail Page

**Path**: `/src/app/skills/[id]/page.tsx`

**Features**:
- Fetches skill via `GET /api/skills/{id}/versions/{version}`
- Displays: skill name, description, version, flow diagram
- Uses existing SkillVersionDetailModal content as reference
- Back navigation button
- Error state for skill not found

### 3. Modified Files

| File | Changes |
|------|---------|
| `src/app/details/page.tsx` | Replace skill used text with SkillLink components |
| `src/components/Dashboard.tsx` | Add SkillLink if skills shown in list view |

## URL Format

```
/skills/{skillId}?version={versionNumber}
```

Examples:
- `/skills/skill_my-skill_12345?version=1`
- `/skills/skill_my-skill_12345` (no version = latest)

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Skill deleted | Show "Skill not found" page with back button |
| Invalid version | Fall back to latest version |
| Missing skillId | Render plain text with tooltip |
| API error | Show error message with retry option |

## Data Flow

1. User views execution record with skill used field
2. SkillName rendered as `<SkillLink>` component
3. User clicks skill name
4. Navigate to `/skills/[id]?version=[version]`
5. Page fetches skill data via API
6. Display skill details with flow diagram

## Testing Strategy

### Unit Tests
- SkillLink component rendering
- Navigation URL generation
- Error state handling

### Integration Tests
- Click skill → navigate to detail page
- Skill detail page data fetching
- Error scenarios (deleted skill, invalid version)

### Manual Tests
- Visual styling verification
- Multiple skills display
- Back navigation

## Implementation Tasks

1. Create SkillLink component
2. Create skill detail page route
3. Create skill detail page component
4. Modify details page to use SkillLink
5. Add error handling
6. Write tests
7. Verify all acceptance criteria
