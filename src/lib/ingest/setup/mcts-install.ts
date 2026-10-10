export function isMctsRepoPath(value: string): boolean {
    return value.trim().startsWith('/') && !/[\0\r\n]/.test(value);
}

export function mctsInstallCommand(url: string, repoDir: string): string {
    if (!isMctsRepoPath(repoDir)) return '';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `curl -sSf ${quote(url)} | AGENT_INSIGHT_MCTS_REPO_DIR=${quote(repoDir.trim())} bash`;
}
