import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 确保内置「messages 日志分析」示例日志存在于平台数据根 `<home>/.agent-insight/example/messages`。
 *
 * 为什么放启动时:内置 case 的 query 写的是 `~/.agent-insight/example/messages`(执行时由
 * expandHomePathsInText 展开成 `os.homedir()/.agent-insight/example/messages`)。换台干净服务器 /
 * 重装后那个路径可能没文件 → agent 一读就 "No such file" 直接结束。这里在启动时"不在才补"一份。
 *
 * 语义 A:**存在即跳过, 绝不覆盖**(用户/旧版本那份原样保留);仅缺失时从仓库
 * `<cwd>/public/example/messages` 复制。全平台共用一份(静态示例, 不分用户)。
 *
 * @returns 'exists'(已有, 没动) | 'copied'(补了一份) | 'skipped'(仓库源也没有, 静默放过)
 */
export function ensureExampleMessagesFile(opts?: { home?: string; cwd?: string }): 'exists' | 'copied' | 'skipped' {
    const home = opts?.home ?? os.homedir();
    const cwd = opts?.cwd ?? process.cwd();
    const dest = path.join(home, '.agent-insight', 'example', 'messages');
    if (fs.existsSync(dest)) return 'exists';   // A: 存在即跳过, 不写一个字节
    const src = path.join(cwd, 'public', 'example', 'messages');
    if (!fs.existsSync(src)) return 'skipped';  // 仓库里也没有(理论不会), 静默放过
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 'copied';
}
