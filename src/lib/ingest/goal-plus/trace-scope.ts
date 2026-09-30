export function goalPlusCurrentRunIds(searchTasksJson: string | null): string[] {
  try {
    const tasks: unknown = JSON.parse(searchTasksJson || '[]');
    if (!Array.isArray(tasks)) return [];
    return [...new Set(tasks.flatMap(task => {
      const id = task && typeof task === 'object' ? task.runId : undefined;
      return typeof id === 'string' && id.trim() ? [id.trim()] : [];
    }))];
  } catch {
    return [];
  }
}
