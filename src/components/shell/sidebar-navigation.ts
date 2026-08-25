export type SidebarIconKey =
    | 'dashboard'
    | 'quickstart'
    | 'observe'
    | 'agent'
    | 'trace'
    | 'infra'
    | 'evaluation'
    | 'experiment'
    | 'dataset'
    | 'metrics'
    | 'diagnosis'
    | 'optimization'
    | 'skill'
    | 'config'
    | 'model'
    | 'web'
    | 'install'
    | 'usage';

export type SidebarBadgeKind = 'r' | 'y' | 'g';

export interface SidebarNavItem {
    key: string;
    labelKey: string;
    icon: SidebarIconKey;
    href?: string;
    matchPrefixes?: string[];
    badge?: { text: string; kind: SidebarBadgeKind };
    children?: SidebarNavItem[];
}

const DASHBOARD_ITEM: SidebarNavItem = {
    key: 'dashboard',
    href: '/dashboard',
    labelKey: 'nav.dashboard',
    icon: 'dashboard',
};

const QUICKSTART_ITEM: SidebarNavItem = {
    key: 'quickstart',
    href: '/quickstart',
    labelKey: 'nav.quickStart',
    icon: 'quickstart',
};

const OBSERVE_ITEM: SidebarNavItem = {
    key: 'observe',
    labelKey: 'nav.groupObserve',
    icon: 'observe',
    children: [
        { key: 'agents', href: '/agents', labelKey: 'nav.agents', icon: 'agent' },
        {
            key: 'trace',
            href: '/trace',
            labelKey: 'nav.trace',
            icon: 'trace',
            matchPrefixes: ['/trace', '/details'],
        },
        { key: 'infra', href: '/infra', labelKey: 'nav.infra', icon: 'infra' },
    ],
};

const EVALUATION_ITEM: SidebarNavItem = {
    key: 'evaluation',
    labelKey: 'nav.evalCenter',
    icon: 'evaluation',
    children: [
        { key: 'experiments', href: '/experiments', labelKey: 'nav.experiments', icon: 'experiment' },
        { key: 'dataset', href: '/dataset', labelKey: 'nav.evalDataset', icon: 'dataset' },
        { key: 'metrics', href: '/metrics', labelKey: 'nav.evalMetrics', icon: 'metrics' },
    ],
};

const DIAGNOSIS_ITEM: SidebarNavItem = {
    key: 'diagnosis',
    href: '/fault',
    labelKey: 'nav.fault',
    icon: 'diagnosis',
};

const CONTINUOUS_OPTIMIZATION_ITEM: SidebarNavItem = {
    key: 'continuous-optimization',
    labelKey: 'nav.groupSkills',
    icon: 'optimization',
    children: [
        {
            key: 'skill',
            href: '/skills',
            labelKey: 'nav.skillWorkspace',
            icon: 'skill',
            matchPrefixes: [
                '/skill-workbench',
                '/skills',
                '/skill-history',
                '/skill-detail',
                '/skill-generator',
                '/skill-eval',
                '/skill-opt',
            ],
        },
    ],
};

const CONFIG_CHILDREN: SidebarNavItem[] = [
    { key: 'skill-management', href: '/config/skills', labelKey: 'nav.skillManagement', icon: 'skill' },
    { key: 'model-registry', href: '/modelconfig/registry', labelKey: 'nav.modelRegistry', icon: 'model' },
    { key: 'web-search', href: '/modelconfig/web-search', labelKey: 'nav.webSearch', icon: 'web' },
    { key: 'access-install', href: '/accessconfig/install', labelKey: 'nav.accessInstall', icon: 'install' },
    { key: 'access-client', href: '/accessconfig/client', labelKey: 'nav.accessClient', icon: 'install' },
];

const USAGE_ITEM: SidebarNavItem = {
    key: 'usage',
    href: '/usage',
    labelKey: 'nav.usageAnalytics',
    icon: 'usage',
    badge: { text: 'ADMIN', kind: 'g' },
};

export function getSidebarNavigation(showUsage: boolean): SidebarNavItem[] {
    return [
        DASHBOARD_ITEM,
        QUICKSTART_ITEM,
        OBSERVE_ITEM,
        EVALUATION_ITEM,
        DIAGNOSIS_ITEM,
        CONTINUOUS_OPTIMIZATION_ITEM,
        {
            key: 'config',
            labelKey: 'nav.configGroup',
            icon: 'config',
            children: showUsage ? [...CONFIG_CHILDREN, USAGE_ITEM] : CONFIG_CHILDREN,
        },
    ];
}

function normalizePath(pathname: string, basePath = ''): string {
    const stripped = basePath && pathname.startsWith(basePath)
        ? pathname.slice(basePath.length)
        : pathname;
    return stripped || '/';
}

export function isSidebarItemActive(
    item: SidebarNavItem,
    pathname: string,
    basePath = '',
): boolean {
    if (!item.href) {
        return (item.children ?? []).some(child => isSidebarItemActive(child, pathname, basePath));
    }

    const current = normalizePath(pathname, basePath);
    const prefixes = item.matchPrefixes ?? [item.href];
    return prefixes.some(prefix => current === prefix || current.startsWith(`${prefix}/`));
}
