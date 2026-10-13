import { useCallback, useEffect, useRef, useState } from 'react';

import {
  employeeDashboardApi,
  type EmployeeDashboard,
  type EmployeeDashboardQuery,
} from '../api/employee-dashboard-api.js';

export type EmployeeDashboardLoadState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; dashboard: EmployeeDashboard }>;

type StoredDashboardState = EmployeeDashboardLoadState & Readonly<{ queryKey: string }>;

function queryKey(query: EmployeeDashboardQuery): string {
  return JSON.stringify([
    query.historyPage ?? 1,
    query.historyPageSize ?? 20,
    query.historyFrom ?? null,
    query.historyTo ?? null,
    query.requestPage ?? 1,
    query.requestPageSize ?? 20,
  ]);
}

export function useEmployeeDashboard(
  query: EmployeeDashboardQuery,
): Readonly<{ state: EmployeeDashboardLoadState; retry: () => void }> {
  const [storedState, setStoredState] = useState<StoredDashboardState | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const generation = useRef(0);
  const currentQueryKey = queryKey(query);
  const historyPage = query.historyPage;
  const historyPageSize = query.historyPageSize;
  const historyFrom = query.historyFrom;
  const historyTo = query.historyTo;
  const requestPage = query.requestPage;
  const requestPageSize = query.requestPageSize;

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    const currentKey = JSON.stringify([
      historyPage ?? 1,
      historyPageSize ?? 20,
      historyFrom ?? null,
      historyTo ?? null,
      requestPage ?? 1,
      requestPageSize ?? 20,
    ]);
    const request: EmployeeDashboardQuery = {
      ...(historyPage === undefined ? {} : { historyPage }),
      ...(historyPageSize === undefined ? {} : { historyPageSize }),
      ...(historyFrom === undefined ? {} : { historyFrom }),
      ...(historyTo === undefined ? {} : { historyTo }),
      ...(requestPage === undefined ? {} : { requestPage }),
      ...(requestPageSize === undefined ? {} : { requestPageSize }),
    };

    setStoredState({ queryKey: currentKey, status: 'loading' });
    void employeeDashboardApi
      .getDashboard(request, { signal: controller.signal })
      .then((dashboard) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setStoredState({ queryKey: currentKey, status: 'loaded', dashboard });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setStoredState({ queryKey: currentKey, status: 'error', error });
        }
      });

    return () => {
      controller.abort();
      if (generation.current === currentGeneration) generation.current += 1;
    };
  }, [
    historyPage,
    historyPageSize,
    historyFrom,
    historyTo,
    requestPage,
    requestPageSize,
    retryCount,
  ]);

  const retry = useCallback(() => setRetryCount((current) => current + 1), []);
  const state =
    storedState?.queryKey === currentQueryKey
      ? storedState
      : ({ status: 'loading' } satisfies EmployeeDashboardLoadState);

  return { state, retry };
}
