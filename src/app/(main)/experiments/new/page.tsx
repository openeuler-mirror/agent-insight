'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { NH_DEMO } from '@/lib/evaluation-harness/demo-profile';
import { ExperimentWizard } from '@/components/experiments/ExperimentWizard';
import DemoExperimentWizard from '@/components/evaluation-harness/DemoExperimentWizard';
export { ExperimentWizard } from '@/components/experiments/ExperimentWizard';
export type { SkillExperimentContext, SkillExperimentPreset } from '@/components/experiments/ExperimentWizard';

export default function NewExperimentPage() {
  if (!NH_DEMO) return <ExperimentWizard />;
  return <><AppTopBar title="新建实验" /><PageContainer className="[&>*]:shrink-0"><DemoExperimentWizard /></PageContainer></>;
}
