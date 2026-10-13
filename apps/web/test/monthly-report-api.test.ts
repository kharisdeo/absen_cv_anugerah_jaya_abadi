import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MONTHLY_REPORT_XLSX_MIME,
  MonthlyReportApiError,
  isMonthlyReportMonth,
  monthlyReportApi,
  type MonthlyReport,
} from '../src/api/monthly-report-api.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000101';
const STORE_ID = '00000000-0000-4000-8000-000000000102';
const SHIFT_ID = '00000000-0000-4000-8000-000000000103';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000104';
const fetchMock = vi.fn<typeof fetch>();

function reportPayload(
  month = '2026-10',
  filters: Readonly<{ storeId: string | null; employeeId: string | null }> = {
    storeId: null,
    employeeId: null,
  },
): MonthlyReport {
  return {
    month,
    filters,
    definitions: {
      workDays: 'scheduled_employee_work_dates_excluding_holidays',
      workMinutes: 'valid_approved_pair_rounded_to_nearest_minute_less_shift_break',
      lateMinutes: 'rounded_minutes_after_scheduled_start_including_tolerance',
      overtime: 'approved_admin_requests_unique_store_when_store_scoped',
    },
    summary: [
      {
        employeeId: EMPLOYEE_ID,
        employeeName: 'Nama karyawan',
        workDays: 1,
        present: 2,
        lateCount: 0,
        lateMinutes: 0,
        absent: 0,
        leave: 0,
        sick: 0,
        annualLeave: 0,
        totalWorkMinutes: 900,
        approvedOvertimeMinutes: 0,
      },
    ],
    dailyDetails: [
      {
        employeeId: EMPLOYEE_ID,
        employeeName: 'Nama karyawan',
        date: `${month}-12`,
        store: { id: STORE_ID, name: 'Toko Utama' },
        shift: { assignmentId: ASSIGNMENT_ID, id: SHIFT_ID, name: 'Pagi' },
        checkInAt: '2026-10-12T01:00:00.000Z',
        checkOutAt: '2026-10-12T09:00:00.000Z',
        durationMinutes: 450,
        lateMinutesAfterScheduledStart: 0,
        status: 'PRESENT',
        checkInValidationStatus: 'VALID',
        checkOutValidationStatus: 'VALID',
        validationStatus: 'VALID',
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

describe('monthly report API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('accepts valid month values and rejects impossible month syntax', () => {
    expect(isMonthlyReportMonth('2024-02')).toBe(true);
    expect(isMonthlyReportMonth('0001-01')).toBe(true);
    expect(isMonthlyReportMonth('0000-01')).toBe(false);
    expect(isMonthlyReportMonth('2026-13')).toBe(false);
    expect(isMonthlyReportMonth('2026-1')).toBe(false);
  });

  it('requests the exact report route with optional scoped filters and no-store cookies', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(reportPayload('2026-10', { storeId: STORE_ID, employeeId: EMPLOYEE_ID })),
    );
    const controller = new AbortController();

    await expect(
      monthlyReportApi.getMonthlyReport(
        { month: '2026-10', storeId: STORE_ID, employeeId: EMPLOYEE_ID },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ month: '2026-10', summary: [{ workDays: 1, present: 2 }] });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/reports/monthly?month=2026-10&storeId=${STORE_ID}&employeeId=${EMPLOYEE_ID}`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
    );
  });

  it('rejects invalid input before network access and rejects inconsistent report payloads', async () => {
    await expect(monthlyReportApi.getMonthlyReport({ month: '2026-13' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REPORT_INPUT',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...reportPayload(), definitions: {} }));
    await expect(monthlyReportApi.getMonthlyReport({ month: '2026-10' })).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects details outside the requested month and summary name inconsistencies', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...reportPayload(),
        dailyDetails: [{ ...reportPayload().dailyDetails[0], date: '2026-09-30' }],
      }),
    );
    await expect(monthlyReportApi.getMonthlyReport({ month: '2026-10' })).rejects.toBeInstanceOf(
      MonthlyReportApiError,
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...reportPayload(),
        dailyDetails: [{ ...reportPayload().dailyDetails[0], employeeName: 'Nama lain' }],
      }),
    );
    await expect(monthlyReportApi.getMonthlyReport({ month: '2026-10' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('downloads only the documented XLSX media type with a ZIP signature', async () => {
    const workbook = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], {
      type: MONTHLY_REPORT_XLSX_MIME,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(workbook, {
        status: 200,
        headers: { 'Content-Type': `${MONTHLY_REPORT_XLSX_MIME}; charset=binary` },
      }),
    );
    await expect(
      monthlyReportApi.exportMonthlyReport({ month: '2026-10' }),
    ).resolves.toBeInstanceOf(Blob);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/reports/monthly/export?month=2026-10');

    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(['not xlsx'], { type: 'application/json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(monthlyReportApi.exportMonthlyReport({ month: '2026-10' })).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });
});
