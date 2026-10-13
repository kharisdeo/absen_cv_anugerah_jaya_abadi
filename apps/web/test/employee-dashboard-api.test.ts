import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toUserErrorMessage } from '../src/api/error-message.js';
import {
  createEmployeeDashboardApi,
  EmployeeDashboardApiError,
  isCalendarDate,
} from '../src/api/employee-dashboard-api.js';

const ids = {
  employee: '00000000-0000-4000-8000-000000000101',
  assignment: '00000000-0000-4000-8000-000000000102',
  shift: '00000000-0000-4000-8000-000000000103',
  store: '00000000-0000-4000-8000-000000000104',
  attendance: '00000000-0000-4000-8000-000000000105',
  attendance2: '00000000-0000-4000-8000-000000000106',
  request: '00000000-0000-4000-8000-000000000107',
};

const todayItem = {
  employeeId: ids.employee,
  employeeName: 'Nama Pribadi Tidak Ditampilkan',
  shiftAssignmentId: ids.assignment,
  shiftId: ids.shift,
  shiftName: 'Shift malam',
  scheduledStartTime: '22:00:00',
  scheduledEndTime: '06:00:00',
  store: { id: ids.store, name: 'Toko Contoh' },
  date: '2026-10-11',
  status: 'NOT_CHECKED_IN',
  checkInAt: null,
  checkOutAt: null,
  minutesAfterScheduledStart: null,
} as const;

const dashboard = {
  today: [],
  history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
  requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('employee dashboard API client', () => {
  const fetcher = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetcher.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends only allowed server-side history filters, pages, and personal session credentials', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({
        ...dashboard,
        history: { items: [], page: 2, pageSize: 10, hasNextPage: true },
        requests: { items: [], page: 3, pageSize: 5, hasNextPage: false },
      }),
    );
    const api = createEmployeeDashboardApi({ apiBaseUrl: '/api/v1/', fetcher });
    const controller = new AbortController();

    await api.getDashboard(
      {
        historyPage: 2,
        historyPageSize: 10,
        historyFrom: '2026-10-01',
        historyTo: '2026-10-31',
        requestPage: 3,
        requestPageSize: 5,
      },
      { signal: controller.signal },
    );

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/me/dashboard?historyPage=2&historyPageSize=10&historyFrom=2026-10-01&historyTo=2026-10-31&requestPage=3&requestPageSize=5',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('employeeId');
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('date=');
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('storeId=');
  });

  it('permits either inclusive calendar bound by itself and safely accepts future bounds', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    for (const [query, queryString] of [
      [{ historyFrom: '2027-02-01' }, '?historyFrom=2027-02-01'],
      [{ historyTo: '2027-02-28' }, '?historyTo=2027-02-28'],
    ] as const) {
      fetcher.mockResolvedValueOnce(jsonResponse(dashboard));
      await api.getDashboard(query);
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/v1/me/dashboard${queryString}`);
    }
  });

  it('rejects invalid dates, inverted ranges, invalid pagination, and owner overrides before fetch', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    const invalidQueries = [
      { historyFrom: '2026-2-01' },
      { historyFrom: '2026-02-30' },
      { historyFrom: '2026-10-12', historyTo: '2026-10-11' },
      { historyPage: 0 },
      { historyPage: 10_001 },
      { historyPageSize: 51 },
      { requestPageSize: 0 },
      { employeeId: ids.employee },
    ];

    for (const query of invalidQueries) {
      await expect(api.getDashboard(query as never)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_DASHBOARD_INPUT',
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2025-02-29')).toBe(false);
  });

  it('validates exact response DTOs, status enums, and page metadata', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    const invalidBodies = [
      { ...dashboard, leaveBalance: 0 },
      {
        ...dashboard,
        history: {
          items: [
            {
              id: ids.attendance,
              date: '2026-10-11',
              type: 'CHECK_IN',
              serverTime: '2026-10-11T22:00:00.000Z',
              validationStatus: 'VALID',
              store: null,
              shift: null,
              latitude: -6.2,
            },
          ],
          page: 1,
          pageSize: 20,
          hasNextPage: false,
        },
      },
      {
        ...dashboard,
        history: {
          items: [
            {
              id: ids.attendance,
              date: '2026-10-11',
              type: 'CHECK_IN',
              serverTime: '2026-10-11T22:00:00.000Z',
              validationStatus: 'UNKNOWN',
              store: null,
              shift: null,
            },
          ],
          page: 1,
          pageSize: 20,
          hasNextPage: false,
        },
      },
      {
        ...dashboard,
        today: [{ ...todayItem, status: 'UNKNOWN' }],
      },
      {
        ...dashboard,
        history: { items: [], page: 2, pageSize: 20, hasNextPage: false },
      },
    ];

    for (const body of invalidBodies) {
      fetcher.mockResolvedValueOnce(jsonResponse(body));
      await expect(api.getDashboard()).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_RESPONSE',
      });
    }
  });

  it('rejects a successful but unexpected HTTP status for the dashboard GET', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    fetcher.mockResolvedValueOnce(jsonResponse(dashboard, 201));
    await expect(api.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('preserves distinct server statuses for offline and verification records', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    fetcher.mockResolvedValueOnce(
      jsonResponse({
        ...dashboard,
        history: {
          items: [
            {
              id: ids.attendance,
              date: '2026-10-11',
              type: 'CHECK_IN',
              serverTime: '2026-10-11T15:00:00.000Z',
              validationStatus: 'PENDING_OFFLINE',
              store: null,
              shift: null,
            },
            {
              id: ids.attendance2,
              date: '2026-10-11',
              type: 'CHECK_OUT',
              serverTime: '2026-10-11T15:05:00.000Z',
              validationStatus: 'PENDING_VERIFICATION',
              store: null,
              shift: null,
            },
          ],
          page: 1,
          pageSize: 20,
          hasNextPage: false,
        },
      }),
    );

    const result = await api.getDashboard();
    expect(result.history.items.map((item) => item.validationStatus)).toEqual([
      'PENDING_OFFLINE',
      'PENDING_VERIFICATION',
    ]);
  });

  it('keeps wall-clock overnight schedule values unchanged and rejects response oversharing', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    fetcher.mockResolvedValueOnce(jsonResponse({ ...dashboard, today: [todayItem] }));
    const result = await api.getDashboard();
    expect(result.today[0]).toMatchObject({
      scheduledStartTime: '22:00:00',
      scheduledEndTime: '06:00:00',
      date: '2026-10-11',
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse({
        ...dashboard,
        today: [{ ...todayItem, selfieUrl: 'https://private.invalid' }],
      }),
    );
    await expect(api.getDashboard()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps server error codes without exposing detail fields', async () => {
    const api = createEmployeeDashboardApi({ fetcher });
    fetcher.mockResolvedValueOnce(
      jsonResponse({ code: 'INVALID_DASHBOARD_INPUT', detail: 'internal database detail' }, 400),
    );

    try {
      await api.getDashboard({ historyFrom: '2026-10-01' });
      throw new Error('expected the server error to be rejected');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EmployeeDashboardApiError);
      expect(error).toMatchObject({ status: 400, code: 'INVALID_DASHBOARD_INPUT' });
      expect(toUserErrorMessage(error)).toContain('rentang tanggal');
      expect(toUserErrorMessage(error)).not.toContain('internal database detail');
    }
  });
});
