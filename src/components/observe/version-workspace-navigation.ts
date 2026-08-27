export type VersionWorkspaceTabKey = 'analysis' | 'management';

export interface VersionWorkspaceTab {
    key: VersionWorkspaceTabKey;
    href: string;
    labelKey: string;
    matchPrefixes: string[];
}

export const VERSION_WORKSPACE_TABS: VersionWorkspaceTab[] = [
    {
        key: 'analysis',
        href: '/version-analysis',
        labelKey: 'nav.versionAnalysis',
        matchPrefixes: ['/version-analysis'],
    },
    {
        key: 'management',
        href: '/version-management',
        labelKey: 'nav.versionManagement',
        matchPrefixes: ['/version-management'],
    },
];

export function getActiveVersionWorkspaceTab(
    pathname: string,
    basePath = '',
): VersionWorkspaceTabKey | null {
    const current = basePath && pathname.startsWith(basePath)
        ? pathname.slice(basePath.length) || '/'
        : pathname;
    const active = VERSION_WORKSPACE_TABS.find(tab =>
        tab.matchPrefixes.some(prefix => current === prefix || current.startsWith(`${prefix}/`)),
    );
    return active?.key ?? null;
}
