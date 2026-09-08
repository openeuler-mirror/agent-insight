'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import DemoExperimentWizard from '@/components/evaluation-harness/DemoExperimentWizard';
export { ExperimentWizard } from '@/components/experiments/ExperimentWizard';
export type { SkillExperimentContext, SkillExperimentPreset } from '@/components/experiments/ExperimentWizard';

export default function NewExperimentPage() {
  return <><AppTopBar title="新建实验" /><PageContainer className="px-3 sm:px-6 [&>*]:shrink-0"><DemoExperimentWizard /></PageContainer></>;
}
