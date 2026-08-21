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
        ['agents', 'trace', 'infra'],
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
        ['model-registry', 'web-search', 'access-install', 'access-client'],
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

    const navigationForAdmin = getSidebarNavigation(true);
    assert.deepEqual(
        navigationForAdmin.find(item => item.key === 'config')?.children?.map(item => item.key),
        ['model-registry', 'web-search', 'access-install', 'access-client', 'usage'],
    );
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

test('四个 Skill 首页都挂载统一工作区页签', () => {
    const appDir = path.join(process.cwd(), 'src/app/(main)');
    const pages = [
        'skills/page.tsx',
        'skill-generator/page.tsx',
        'skill-eval/page.tsx',
        'skill-opt/page.tsx',
    ];

    for (const page of pages) {
        const source = fs.readFileSync(path.join(appDir, page), 'utf8');
        assert.match(source, /<SkillWorkspaceTabs\s*\/>/, `${page} 应挂载 SkillWorkspaceTabs`);
    }
});
