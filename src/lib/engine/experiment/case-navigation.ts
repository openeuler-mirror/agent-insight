/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const CASE_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function pageNumber(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number !== 0 ? Math.min(Math.max(number, 1), maximum) : fallback;
}

export function casePagination(page?: unknown, pageSize?: unknown) {
  return { casePage: pageNumber(page, 1), casePageSize: pageNumber(pageSize, 20, 100) };
}

export function locateCasePage(caseIds: readonly string[], page: number, pageSize: number, caseId = '') {
  const index = caseId ? caseIds.indexOf(caseId) : -1;
  const lastPage = Math.max(1, Math.ceil(caseIds.length / pageSize));
  return {
    casePage: index >= 0 ? Math.floor(index / pageSize) + 1 : Math.min(page, lastPage),
    locatedCaseId: index >= 0 ? caseId : null,
  };
}

export function caseRowId(caseId: string): string {
  return `experiment-case-${encodeURIComponent(caseId)}`;
}

export function experimentCaseHref(id: string, caseId: string, page: number, pageSize: number): string {
  const pagination = casePagination(page, pageSize);
  const query = new URLSearchParams({ casePage: String(pagination.casePage), casePageSize: String(pagination.casePageSize) });
  return `/experiments/${encodeURIComponent(id)}/cases/${encodeURIComponent(caseId)}?${query}`;
}

export function experimentDetailHref(id: string, caseId: string, page: number, pageSize: number): string {
  const pagination = casePagination(page, pageSize);
  const query = new URLSearchParams({ casePage: String(pagination.casePage), casePageSize: String(pagination.casePageSize), focusCaseId: caseId });
  return `/experiments/${encodeURIComponent(id)}?${query}`;
}
