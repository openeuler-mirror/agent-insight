import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('客户分支只显示仪表盘、链路追踪和客户端安装，管理员保持相同入口', async () => {
    const { getSidebarNavigation, isSidebarItemActive } = await import(
        '../src/components/shell/sidebar-navigation'
    );

    for (const showUsage of [false, true]) {
        const navigation = getSidebarNavigation(showUsage);
        assert.deepEqual(
            navigation.map(item => [item.key, item.href, item.labelKey]),
            [
                ['dashboard', '/dashboard', 'nav.dashboard'],
                ['trace', '/trace', 'nav.trace'],
                ['access-install', '/accessconfig/install', 'nav.accessInstall'],
            ],
        );
        assert.ok(navigation.every(item => !item.children?.length));

        const traceItem = navigation.find(item => item.key === 'trace')!;
        assert.equal(isSidebarItemActive(traceItem, '/trace'), true);
        assert.equal(isSidebarItemActive(traceItem, '/details/example'), true);
        assert.equal(isSidebarItemActive(traceItem, '/insight/details/example', '/insight'), true);
        assert.equal(isSidebarItemActive(traceItem, '/trace-other'), false);

        const installItem = navigation.find(item => item.key === 'access-install')!;
        assert.equal(isSidebarItemActive(installItem, '/accessconfig/install'), true);
        assert.equal(isSidebarItemActive(installItem, '/accessconfig/client'), false);
    }
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
