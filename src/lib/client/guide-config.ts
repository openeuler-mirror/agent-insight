import { GuideStep } from '@/components/onboarding/UserGuide';

export interface GuideStepConfig {
    id: string;
    target: string;
    titleKey: string;
    contentKey: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'center';
    action?: () => void;
    actionLabelKey?: string;
    linkUrl?: string;
    linkTextKey?: string;
    setupCommands?: {
        linux: string;
        windows: string;
    };
    apiKey?: string;
}

export const GUIDE_STEPS_CONFIG: GuideStepConfig[] = [
    {
        id: 'welcome',
        target: '',
        titleKey: 'guide.welcome.title',
        contentKey: 'guide.welcome.content',
        position: 'center',
    },
    {
        id: 'eval-config',
        target: '.controls',
        titleKey: 'guide.evalConfig.title',
        contentKey: 'guide.evalConfig.content',
        position: 'bottom',
        actionLabelKey: 'guide.evalConfig.actionLabel',
    },
    {
        id: 'dataset-config',
        target: '.tabs .tab-btn:nth-child(2)',
        titleKey: 'guide.datasetConfig.title',
        contentKey: 'guide.datasetConfig.content',
        position: 'bottom',
        actionLabelKey: 'guide.datasetConfig.actionLabel',
    },
    {
        id: 'skill-upload',
        target: '.tabs .tab-btn:nth-child(3)',
        titleKey: 'guide.skillUpload.title',
        contentKey: 'guide.skillUpload.content',
        position: 'bottom',
        actionLabelKey: 'guide.skillUpload.actionLabel',
    },
    {
        id: 'user-manual',
        target: '.title',
        titleKey: 'guide.userManual.title',
        contentKey: 'guide.userManual.content',
        position: 'bottom',
        linkUrl: 'https://atomgit.com/openeuler/witty-skill-insight/wiki/%E7%94%A8%E6%88%B7%E4%BD%BF%E7%94%A8%E6%89%8B%E5%86%8C',
        linkTextKey: 'guide.userManual.linkText',
    },
];

export function getFilteredStepsConfig(completedSteps: string[], skippedSteps: string[]): GuideStepConfig[] {
    return GUIDE_STEPS_CONFIG.filter(step => 
        !completedSteps.includes(step.id) && !skippedSteps.includes(step.id)
    );
}

export function getStepIndex(stepId: string): number {
    return GUIDE_STEPS_CONFIG.findIndex(step => step.id === stepId);
}
