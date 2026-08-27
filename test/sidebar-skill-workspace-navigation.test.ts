import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('左侧导航遵循新的一级模块与现有页面映射', async () => {
    const { getSidebarNavigation, isSidebarItemActive } = await import(
        '../src/components/shell/sidebar-navigation'
    );

    const navigation = getSidebarNavigation(false);
    assert.deepEqual(
        navigation.map(item => item.key),
        ['dashboard', 'quickstart', 'observe', 'evaluation', 'diagnosis', 'continuous-optimization', 'config'],
    );

    const quickstartItem = navigation.find(item => item.key === 'quickstart');
    assert.equal(quickstartItem?.href, '/quickstart');
    assert.equal(isSidebarItemActive(quickstartItem!, '/quickstart'), true);

    assert.deepEqual(
        navigation.find(item => item.key === 'observe')?.children?.map(item => item.key),
        ['agents', 'trace', 'version-analysis', 'infra'],
    );
    assert.deepEqual(
        navigation.find(item => item.key === 'evaluation')?.children?.map(item => item.key),
        ['experiments', 'dataset', 'metrics'],
    );
    assert.deepEqual(
        navigation.find(item => item.key === 'continuous-optimization')?.children?.map(item => item.key),
        ['skill'],
    );
    assert.deepEqual(
        navigation.find(item => item.key === 'config')?.children?.map(item => item.key),
        ['skill-management', 'model-registry', 'web-search', 'access-install', 'access-client'],
    );

    const skillItem = navigation
        .find(item => item.key === 'continuous-optimization')
        ?.children?.find(item => item.key === 'skill');
    assert.ok(skillItem);
    assert.equal(isSidebarItemActive(skillItem, '/skill-generator'), true);
    assert.equal(isSidebarItemActive(skillItem, '/skill-eval/trigger/demo'), true);
    assert.equal(isSidebarItemActive(skillItem, '/skill-opt/demo/v1'), true);

    const traceItem = navigation
        .find(item => item.key === 'observe')
        ?.children?.find(item => item.key === 'trace');
    assert.ok(traceItem);
    assert.equal(isSidebarItemActive(traceItem, '/details'), true);

    const versionAnalysisItem = navigation
        .find(item => item.key === 'observe')
        ?.children?.find(item => item.key === 'version-analysis');
    assert.ok(versionAnalysisItem);
    assert.equal(versionAnalysisItem.href, '/version-analysis');
    assert.equal(isSidebarItemActive(versionAnalysisItem, '/version-analysis'), true);
    assert.equal(isSidebarItemActive(versionAnalysisItem, '/version-management'), true);

    const navigationForAdmin = getSidebarNavigation(true);
    assert.deepEqual(
        navigationForAdmin.find(item => item.key === 'config')?.children?.map(item => item.key),
        ['skill-management', 'model-registry', 'web-search', 'access-install', 'access-client', 'usage'],
    );
});

test('版本分析工作区通过页签承载分析与管理两个子能力', async () => {
    const componentPath = path.join(process.cwd(), 'src/components/observe/VersionWorkspaceTabs.tsx');
    const navigationPath = path.join(process.cwd(), 'src/components/observe/version-workspace-navigation.ts');
    assert.equal(fs.existsSync(componentPath), true, '应提供版本分析工作区页签组件');
    assert.equal(fs.existsSync(navigationPath), true, '应提供版本分析工作区页签配置');

    const { VERSION_WORKSPACE_TABS, getActiveVersionWorkspaceTab } = await import(
        '../src/components/observe/version-workspace-navigation'
    );
    assert.deepEqual(
        VERSION_WORKSPACE_TABS.map(tab => [tab.key, tab.href]),
        [
            ['analysis', '/version-analysis'],
            ['management', '/version-management'],
        ],
    );
    assert.equal(getActiveVersionWorkspaceTab('/version-analysis'), 'analysis');
    assert.equal(getActiveVersionWorkspaceTab('/version-management'), 'management');

    const appDir = path.join(process.cwd(), 'src/app/(main)');
    for (const page of ['version-analysis/page.tsx', 'version-management/page.tsx']) {
        const source = fs.readFileSync(path.join(appDir, page), 'utf8');
        assert.match(source, /VersionWorkspaceTabs/, `${page} 应挂载版本分析工作区页签`);
    }
});

test('快速开始页面呈现五阶段推荐路径并链接到现有模块', () => {
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src/app/(main)/quickstart/page.tsx'),
        'utf8',
    );

    assert.match(source, /quickstartStages/);
    assert.match(source, /['"]\/accessconfig\/install['"]/);
    assert.match(source, /['"]\/agents['"]/);
    assert.match(source, /['"]\/experiments['"]/);
    assert.match(source, /['"]\/fault['"]/);
    assert.match(source, /['"]\/skills['"]/);
});

test('Skill 工作区保留四个路由，并能识别详情页所属页签', async () => {
    const { SKILL_WORKSPACE_TABS, getActiveSkillWorkspaceTab } = await import(
        '../src/components/skills/skill-workspace-navigation'
    );

    assert.deepEqual(
        SKILL_WORKSPACE_TABS.map(tab => [tab.key, tab.href]),
        [
            ['hub', '/skills'],
            ['generate', '/skill-generator'],
            ['evaluate', '/skill-eval'],
            ['optimize', '/skill-opt'],
        ],
    );
    assert.equal(getActiveSkillWorkspaceTab('/skill-history/42'), 'hub');
    assert.equal(getActiveSkillWorkspaceTab('/skill-eval/trigger/demo'), 'evaluate');
    assert.equal(getActiveSkillWorkspaceTab('/skill-opt/demo/v1'), 'optimize');
});

test('Skill 主入口挂载统一工作台，旧入口保留工作区页签', () => {
    const appDir = path.join(process.cwd(), 'src/app/(main)');
    const skillsPage = fs.readFileSync(path.join(appDir, 'skills/page.tsx'), 'utf8');
    assert.match(skillsPage, /<SkillWorkbenchShell\s*\/>/, 'skills/page.tsx 应挂载 SkillWorkbenchShell');

    const legacyPages = [
        'skill-generator/page.tsx',
        'skill-eval/page.tsx',
        'skill-opt/page.tsx',
    ];

    for (const page of legacyPages) {
        const source = fs.readFileSync(path.join(appDir, page), 'utf8');
        assert.match(source, /<SkillWorkspaceTabs\s*\/>/, `${page} 应挂载 SkillWorkspaceTabs`);
    }
});
