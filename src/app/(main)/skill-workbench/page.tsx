import { AppTopBar } from '@/components/shell/AppTopBar';
import { SkillWorkbenchShell } from '@/components/skill-workbench/SkillWorkbenchShell';

export default function SkillWorkbenchPreviewPage() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppTopBar title="Skill 工作台" showDefaultActions={false} />
      <div className="min-h-0 flex-1">
        <SkillWorkbenchShell />
      </div>
    </div>
  );
}
