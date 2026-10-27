'use client';

import { useCallback, useState } from 'react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { casePagination } from '@/lib/engine/experiment/case-navigation';

const parsers = {
  casePage: parseAsInteger.withDefault(1),
  casePageSize: parseAsInteger.withDefault(20),
  focusCaseId: parseAsString,
};

export function useExperimentCasePagination(embedded = false) {
  const [query, setQuery] = useQueryStates(parsers, { history: 'replace', scroll: false });
  const [local, setLocal] = useState(() => casePagination());
  const pagination = embedded ? local : casePagination(query.casePage, query.casePageSize);
  const updatePagination = useCallback((page: number, size: number) => {
    const next = casePagination(page, size);
    if (embedded) setLocal(next);
    else void setQuery({ ...next, focusCaseId: null });
  }, [embedded, setQuery]);
  const acceptPagination = useCallback((response: { casePage?: number; casePageSize?: number }) => {
    if (response.casePage === undefined || response.casePageSize === undefined) return;
    const next = casePagination(response.casePage, response.casePageSize);
    if (embedded) setLocal(previous => previous.casePage === next.casePage && previous.casePageSize === next.casePageSize ? previous : next);
    else if (query.casePage !== next.casePage || query.casePageSize !== next.casePageSize) void setQuery(next);
  }, [embedded, query.casePage, query.casePageSize, setQuery]);
  return { ...pagination, focusCaseId: embedded ? null : query.focusCaseId, updatePagination, acceptPagination };
}
