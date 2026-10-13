import { useCallback, useEffect, useRef, useState } from 'react';

import {
  adminDashboardApi,
  type AdminDashboard,
  type AdminDashboardQuery,
} from '../api/admin-dashboard-api.js';
import { adminShiftsApi, type WorkShiftDto } from '../api/admin-shifts-api.js';
import { adminStoresApi, type StoreDto } from '../api/admin-stores-api.js';
import {
  ADMIN_DASHBOARD_POLL_INTERVAL_MS,
  startAdminDashboardPolling,
  type AdminDashboardPoller,
} from './admin-dashboard-polling.js';

export type AdminDashboardDataState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; dashboard: AdminDashboard; refreshing: boolean }>;

type StoredDashboardState = Readonly<{
  queryKey: string;
  state: AdminDashboardDataState;
}>;

function dashboardQueryKey(query: AdminDashboardQuery): string {
  return JSON.stringify([
    query.date ?? null,
    query.storeId ?? null,
    query.shiftId ?? null,
    query.page ?? 1,
    query.pageSize ?? 25,
  ]);
}

export function useAdminDashboard(
  query: AdminDashboardQuery,
): Readonly<{ state: AdminDashboardDataState; refresh: () => void }> {
  const [stored, setStored] = useState<StoredDashboardState | null>(null);
  const generation = useRef(0);
  const pollerRef = useRef<AdminDashboardPoller | null>(null);
  const currentKey = dashboardQueryKey(query);
  const date = query.date;
  const storeId = query.storeId;
  const shiftId = query.shiftId;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    const request: AdminDashboardQuery = {
      ...(date === undefined || date === '' ? {} : { date }),
      ...(storeId === undefined || storeId === '' ? {} : { storeId }),
      ...(shiftId === undefined || shiftId === '' ? {} : { shiftId }),
      page,
      pageSize,
    };
    const key = dashboardQueryKey(request);
    let active = true;
    const poller = startAdminDashboardPolling(
      () => adminDashboardApi.getDashboard(request, { signal: controller.signal }),
      {
        onStart: () => {
          if (!active || generation.current !== currentGeneration) return;
          setStored((previous) => {
            if (previous?.queryKey === key && previous.state.status === 'loaded') {
              return {
                queryKey: key,
                state: { ...previous.state, refreshing: true },
              };
            }
            return { queryKey: key, state: { status: 'loading' } };
          });
        },
        onSuccess: (dashboard) => {
          if (!active || generation.current !== currentGeneration) return;
          setStored({
            queryKey: key,
            state: { status: 'loaded', dashboard, refreshing: false },
          });
        },
        onError: (error) => {
          if (!active || generation.current !== currentGeneration) return;
          setStored({ queryKey: key, state: { status: 'error', error } });
        },
      },
      document,
      ADMIN_DASHBOARD_POLL_INTERVAL_MS,
    );
    pollerRef.current = poller;

    return () => {
      active = false;
      poller.stop();
      controller.abort();
      if (generation.current === currentGeneration) generation.current += 1;
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [date, storeId, shiftId, page, pageSize]);

  const refresh = useCallback(() => {
    pollerRef.current?.refresh();
  }, []);
  const state = stored?.queryKey === currentKey ? stored.state : { status: 'loading' as const };
  return { state, refresh };
}

export type AdminDashboardOptionState<T> = Readonly<{
  status: 'loading' | 'loaded' | 'error';
  items: readonly T[];
  error: unknown | null;
}>;

export type AdminDashboardOptionsState = Readonly<{
  stores: AdminDashboardOptionState<StoreDto>;
  shifts: AdminDashboardOptionState<WorkShiftDto>;
}>;

const INITIAL_OPTIONS: AdminDashboardOptionsState = {
  stores: { status: 'loading', items: [], error: null },
  shifts: { status: 'loading', items: [], error: null },
};

export function useAdminDashboardOptions(): Readonly<{
  options: AdminDashboardOptionsState;
  retry: () => void;
}> {
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setOptions((previous) => ({
      stores: { ...previous.stores, status: 'loading', error: null },
      shifts: { ...previous.shifts, status: 'loading', error: null },
    }));

    void adminStoresApi
      .listStores(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setOptions((previous) => ({
            ...previous,
            stores: { status: 'loaded', items, error: null },
          }));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setOptions((previous) => ({
            ...previous,
            stores: { ...previous.stores, status: 'error', error },
          }));
        }
      });

    void adminShiftsApi
      .listShifts(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setOptions((previous) => ({
            ...previous,
            shifts: { status: 'loaded', items, error: null },
          }));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setOptions((previous) => ({
            ...previous,
            shifts: { ...previous.shifts, status: 'error', error },
          }));
        }
      });

    return () => controller.abort();
  }, [retryCount]);

  const retry = useCallback(() => setRetryCount((current) => current + 1), []);
  return { options, retry };
}
