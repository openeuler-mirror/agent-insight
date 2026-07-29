export interface ExperimentTraceFilters {
  search: string;
  from?: Date;
  to?: Date;
  tagIds: string[];
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseExperimentTraceFilters(searchParams: URLSearchParams): ExperimentTraceFilters {
  const tagIds = Array.from(new Set(
    (searchParams.get('tagIds') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )).slice(0, 20);

  return {
    search: (searchParams.get('search') || '').trim().slice(0, 200),
    from: parseDate(searchParams.get('from')),
    to: parseDate(searchParams.get('to')),
    tagIds,
  };
}

export function buildExperimentTraceSearchFilter(search: string) {
  const keyword = search.trim();
  if (!keyword) return {};
  return {
    OR: [
      { id: { contains: keyword } },
      { taskId: { contains: keyword } },
      { query: { contains: keyword } },
    ],
  };
}

export function buildExperimentTraceWhere(
  username: string | null,
  agent: string,
  filters: ExperimentTraceFilters,
) {
  const timestamp = filters.from || filters.to
    ? {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      }
    : undefined;
  const tagFilters = username
    ? filters.tagIds.map((tagId) => ({
        executionTags: {
          some: {
            user: username,
            tagId,
            tag: { user: username, kind: { in: ['version', 'business'] } },
          },
        },
      }))
    : [];

  return {
    ...(username ? { user: username } : {}),
    isSubagent: false,
    ...(agent ? { agentName: agent } : {}),
    ...buildExperimentTraceSearchFilter(filters.search),
    ...(timestamp ? { timestamp } : {}),
    ...(tagFilters.length > 0 ? { AND: tagFilters } : {}),
    ...(filters.tagIds.length > 0 && !username ? { id: { in: [] } } : {}),
  };
}
