import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdminDashboardApiError,
  adminDashboardApi,
  isDashboardCalendarDate,
  type AdminDashboard,
  type AdminDashboardQuery,
} from '../src/api/admin-dashboard-api.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000101';
const SHIFT_ID = '00000000-0000-4000-8000-000000000102';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000103';
const STORE_ID = '00000000-0000-4000-8000-000000000104';
const fetchMock = vi.fn<typeof fetch>();

function addDays(value: string, count: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

const summary = {
  scheduledShifts: 12,
  present: 6,
  late: 2,
  notCheckedIn: 1,
  absent: 1,
  leave: 1,
  sick: 0,
  annualLeave: 1,
  waitingVerification: 0,
  pendingRequests: 0,
};

function shiftItem(status: 'ABSENT' | 'NOT_CHECKED_IN' = 'NOT_CHECKED_IN') {
  return {
    employeeId: ADMIN_ID,
    employeeName: 'Nama Karyawan',
    shiftAssignmentId: ASSIGNMENT_ID,
    shiftId: SHIFT_ID,
    shiftName: 'Shift Pagi',
    scheduledStartTime: '08:00:00',
    scheduledEndTime: '17:00:00',
    store: { id: STORE_ID, name: 'Toko Utama' },
    date: '2026-10-11',
    status,
    checkInAt: null,
    checkOutAt: null,
    minutesAfterScheduledStart: null,
  };
}

function dashboardPayload(page = 1, pageSize = 25): AdminDashboard {
  const trend = Array.from({ length: 30 }, (_, index) => ({
    date: addDays('2026-09-12', index),
    ...summary,
  }));
  return {
    summary,
    notCheckedIn: {
      items: [shiftItem('NOT_CHECKED_IN'), shiftItem('ABSENT')],
      page,
      pageSize,
      hasNextPage: false,
    },
    trend,
    lateRanking: [
      {
        employeeId: ADMIN_ID,
        employeeName: 'Nama Karyawan',
        lateCount: 3,
        lateDays: 2,
        totalMinutesAfterScheduledStart: 36.5,
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Admin dashboard API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses the exact dashboard route, date-only filters, cookie credentials, and no-store cache', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(dashboardPayload(2, 10)));
    const controller = new AbortController();

    await expect(
      adminDashboardApi.getDashboard(
        {
          date: '2026-10-11',
          storeId: STORE_ID,
          shiftId: SHIFT_ID,
          page: 2,
          pageSize: 10,
        },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ summary, notCheckedIn: { page: 2, pageSize: 10 } });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/dashboard?date=2026-10-11&storeId=${STORE_ID}&shiftId=${SHIFT_ID}&page=2&pageSize=10`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
    );
  });

  it('omits empty optional filters and uses the documented pagination defaults', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(dashboardPayload()));
    await adminDashboardApi.getDashboard({ date: '', storeId: '', shiftId: '' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/dashboard?page=1&pageSize=25');
  });

  it('rejects impossible date-only filters and invalid UUIDs before making a request', async () => {
    expect(isDashboardCalendarDate('2024-02-29')).toBe(true);
    expect(isDashboardCalendarDate('2026-02-29')).toBe(false);
    expect(isDashboardCalendarDate('2026-10-11T00:00:00Z')).toBe(false);
    await expect(adminDashboardApi.getDashboard({ date: '2026-02-30' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_DASHBOARD_INPUT',
    });
    await expect(adminDashboardApi.getDashboard({ storeId: 'not-a-uuid' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_DASHBOARD_INPUT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown runtime query keys and requires response pagination to match the request', async () => {
    await expect(
      adminDashboardApi.getDashboard({
        date: '2026-10-11',
        accidental: true,
      } as unknown as AdminDashboardQuery),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DASHBOARD_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse(dashboardPayload(1, 25)));
    await expect(adminDashboardApi.getDashboard({ page: 2, pageSize: 10 })).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('retains the server statuses for the absent list without inferring from time', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(dashboardPayload()));
    const result = await adminDashboardApi.getDashboard({ date: '2026-10-11' });
    expect(result.notCheckedIn.items.map((item) => item.status)).toEqual([
      'NOT_CHECKED_IN',
      'ABSENT',
    ]);
  });

  it('rejects unknown status enums, extra DTO fields, and an incomplete 30-day trend', async () => {
    const unknownStatus = dashboardPayload();
    const brokenStatus = structuredClone(unknownStatus);
    (brokenStatus.notCheckedIn.items[0] as { status: string }).status = 'UNRECOGNIZED';
    fetchMock.mockResolvedValueOnce(jsonResponse(brokenStatus));
    await expect(adminDashboardApi.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...dashboardPayload(), extra: true }));
    await expect(adminDashboardApi.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });

    const shortTrend = dashboardPayload();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...shortTrend, trend: shortTrend.trend.slice(1) }),
    );
    await expect(adminDashboardApi.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects impossible ISO calendar/time/offset values in attendance instants', async () => {
    const payload = dashboardPayload();
    const impossible = structuredClone(payload);
    (impossible.notCheckedIn.items[0] as { checkInAt: string | null }).checkInAt =
      '2026-02-30T08:00:00.000Z';
    fetchMock.mockResolvedValueOnce(jsonResponse(impossible));
    await expect(adminDashboardApi.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });

    const badOffset = structuredClone(payload);
    (badOffset.notCheckedIn.items[0] as { checkInAt: string | null }).checkInAt =
      '2026-10-11T08:00:00+15:00';
    fetchMock.mockResolvedValueOnce(jsonResponse(badOffset));
    await expect(adminDashboardApi.getDashboard()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('keeps server validation errors as safe typed errors for the date-selection UI', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'INVALID_DASHBOARD_INPUT' }, 400));
    let captured: unknown;
    try {
      await adminDashboardApi.getDashboard({ date: '2027-01-01' });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(AdminDashboardApiError);
    expect(captured).toMatchObject({ status: 400, code: 'INVALID_DASHBOARD_INPUT' });
  });
});
