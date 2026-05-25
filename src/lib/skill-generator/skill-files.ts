/**
 * Playground vfs 工具：定位 SKILL.md / 解析 frontmatter。
 *
 * agent 实际产物常落在 `/workspace/<skill-name>/SKILL.md` 子文件夹，
 * 但历史代码多处假设 `/workspace/SKILL.md`。所有需要找到 SKILL.md 的
 * 地方都应走这里，避免在各处重复字符串硬编码。
 */

export interface PlaygroundFileLike {
    content?: string | string[];
    [k: string]: unknown;
}

export type PlaygroundFiles = Record<string, PlaygroundFileLike>;

const WORKSPACE_PREFIX = '/workspace/';
const SKILL_MD_SUFFIX = '/SKILL.md';

/** 把 file 的 content 归一为字符串（vfs 里有 string[] 和 string 两种形态）。 */
export function fileContentToString(file: PlaygroundFileLike | undefined): string {
    if (!file) return '';
    const c = file.content;
    if (Array.isArray(c)) return c.join('\n');
    if (typeof c === 'string') return c;
    return '';
}

/**
 * 在 files 里定位 SKILL.md。优先级：层级最浅（/workspace/SKILL.md 优先于
 * /workspace/foo/SKILL.md），同层级时按插入顺序取第一个。
 */
export function findSkillMdPath(files: PlaygroundFiles | null | undefined): string | null {
    if (!files) return null;
    let best: { path: string; depth: number } | null = null;
    for (const path of Object.keys(files)) {
        if (path === WORKSPACE_PREFIX + 'SKILL.md') return path; // 最浅，直接返回
        if (!path.startsWith(WORKSPACE_PREFIX)) continue;
        if (!path.endsWith(SKILL_MD_SUFFIX)) continue;
        const rel = path.slice(WORKSPACE_PREFIX.length);
        const depth = rel.split('/').length;
        if (!best || depth < best.depth) best = { path, depth };
    }
    return best?.path ?? null;
}

/**
 * 返回 SKILL.md 所在的 skill 文件夹（/workspace/ 下第一段），用于
 * download zip 的扁平化：把这层去掉，zip 里直接是 SKILL.md / scripts / ...。
 * 当 SKILL.md 直接在 /workspace/ 根下时返回 null（没有需要剥的文件夹）。
 */
export function getSkillFolderFromPath(skillMdPath: string | null): string | null {
    if (!skillMdPath) return null;
    if (!skillMdPath.startsWith(WORKSPACE_PREFIX)) return null;
    const rel = skillMdPath.slice(WORKSPACE_PREFIX.length);
    const segments = rel.split('/');
    if (segments.length <= 1) return null; // 直接在 /workspace/ 根下
    return segments[0];
}

export interface SkillMdInfo {
    path: string;
    content: string;
    name?: string;
    description?: string;
    /** SKILL.md 所在文件夹名（/workspace/<folder>/SKILL.md），根目录时为 null。 */
    folder: string | null;
}

const FRONTMATTER_RE = /^---\s*([\s\S]*?)\s*---/;
const NAME_RE = /^name:\s*(.+)$/m;
const DESC_RE = /^description:\s*(.+)$/m;

/**
 * 找到 SKILL.md 并把 frontmatter 里的 name / description 拆出来。
 * frontmatter 缺失或字段缺失时对应字段为 undefined。
 */
export function findSkillMd(files: PlaygroundFiles | null | undefined): SkillMdInfo | null {
    const path = findSkillMdPath(files);
    if (!path || !files) return null;
    const content = fileContentToString(files[path]);
    const fm = content.match(FRONTMATTER_RE)?.[1];
    let name: string | undefined;
    let description: string | undefined;
    if (fm) {
        name = fm.match(NAME_RE)?.[1]?.trim();
        description = fm.match(DESC_RE)?.[1]?.trim();
    }
    return { path, content, name, description, folder: getSkillFolderFromPath(path) };
}

/**
 * 文件名安全化：把 name 里非 [A-Za-z0-9._-] 的字符替换成 _。
 */
export function sanitizeForFilename(raw: string): string {
    return raw.replace(/[^\w.-]+/g, '_');
}
