import os from 'node:os';

/**
 * 把文本里"路径前缀形态"的 `~/` 展开成执行机的绝对 HOME。
 *
 * 为什么需要: `~` 是 shell 的语法糖, 只有交互式 shell / 未加引号的 bash 才会展开成 $HOME。
 * Agent 一旦改用文件读取工具、给路径加了引号、或用 Node/Python 去读, 拿到的就是字面量
 * `~/.agent-insight/...`, 内核/库不认 `~` → "No such file" → 直接结束。所以在 query 进入
 * agent 之前先展开成绝对路径, 让 agent 永远看不到 `~`, 就根治了这个时好时坏的问题。
 *
 * 展开目标用平台进程自己的 HOME(os.homedir(), 这里是 /root)—— 而不是 agent 运行时可能被
 * isolateHome 改掉的 HOME —— 因为内置示例文件就落在平台数据根 `<HOME>/.agent-insight/...`,
 * 且 agent 进程与平台同机, 拿绝对路径(同一文件系统)总能读到。
 *
 * 数据集里仍保留 `~`(保持可移植), 只在运行时按当前执行机 HOME 解析。
 *
 * 只替换"边界处紧跟斜杠"的 `~`(行首 / 空白 / 冒号(含全角) / 引号 / 括号 / 等号 之后),
 * 不动词中间的 `~`(如 a~b)、约等于号(~100)、或不带斜杠的孤立 `~`。
 */
const HOME_PREFIX_RE = /(^|[\s:：'"(（=])~(?=\/)/g;

export function expandHomePathsInText(text: string, home: string = os.homedir()): string {
    if (!text || !home || !text.includes('~')) return text;
    return text.replace(HOME_PREFIX_RE, (_match, boundary) => `${boundary}${home}`);
}
