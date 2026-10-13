// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MonthlyReportPage } from '../src/pages/MonthlyReportPage.js';
import { currentJakartaMonth } from '../src/pages/monthly-report-model.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000201';
const STORE_ID = '00000000-0000-4000-8000-000000000202';
const SHIFT_IDS = ['00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000204'];
const ASSIGNMENT_IDS = [
  '00000000-0000-4000-8000-000000000205',
  '00000000-0000-4000-8000-000000000206',
];
const REPORT_MONTH = currentJakartaMonth();
const fetchMock = vi.fn<typeof fetch>();

function monthlyPayload(url: URL): unknown {
  const month = url.searchParams.get('month') ?? '2026-10';
  const dayRows = Array.from({ length: 26 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return SHIFT_IDS.map((shiftId, shiftIndex) => ({
      employeeId: EMPLOYEE_ID,
      employeeName: 'Karyawan Supervisor',
      date: `${month}-${day}`,
      store: { id: STORE_ID, name: 'Toko Cakupan Supervisor' },
      shift: {
        assignmentId: ASSIGNMENT_IDS[shiftIndex]!,
        id: shiftId,
        name: `Shift ${shiftIndex + 1}`,
      },
      checkInAt: `${month}-${day}T01:00:00.000Z`,
      checkOutAt: `${month}-${day}T09:00:00.000Z`,
      durationMinutes: 450,
      lateMinutesAfterScheduledStart: 0,
      status: 'PRESENT',
      checkInValidationStatus: 'VALID',
      checkOutValidationStatus: 'VALID',
      validationStatus: 'VALID',
    }));
  }).flat();
  return {
    month,
    filters: {
      storeId: url.searchParams.get('storeId'),
      employeeId: url.searchParams.get('employeeId'),
    },
    definitions: {
      workDays: 'scheduled_employee_work_dates_excluding_holidays',
      workMinutes: 'valid_approved_pair_rounded_to_nearest_minute_less_shift_break',
      lateMinutes: 'rounded_minutes_after_scheduled_start_including_tolerance',
      overtime: 'approved_admin_requests_unique_store_when_store_scoped',
    },
    summary: [
      {
        employeeId: EMPLOYEE_ID,
        employeeName: 'Karyawan Supervisor',
        workDays: 26,
        present: 52,
        lateCount: 0,
        lateMinutes: 0,
        absent: 0,
        leave: 0,
        sick: 0,
        annualLeave: 0,
        totalWorkMinutes: 23_400,
        approvedOvertimeMinutes: 0,
      },
    ],
    dailyDetails: dayRows,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname.endsWith('/reports/monthly')) {
      return new Response(JSON.stringify(monthlyPayload(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/admin/stores') || url.pathname.endsWith('/admin/employees')) {
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

async function mount(role: 'ADMIN' | 'SUPERVISOR' = 'SUPERVISOR') {
  root = createRoot(container!);
  await act(async () => {
    root?.render(<MonthlyReportPage role={role} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('monthly report page', () => {
  it('shows the server-scoped Supervisor report and keeps unique work-day semantics visible', async () => {
    await mount();

    expect(container?.textContent).toContain('Laporan kehadiran');
    expect(container?.textContent).toContain('Cakupan mengikuti assignment server');
    expect(container?.textContent).toContain('menghitung tanggal kalender unik');
    expect(container?.textContent).toContain('Karyawan Supervisor');
    const summaryCells = container?.querySelectorAll('tbody td');
    expect(summaryCells?.[1]?.textContent).toBe('26');
    expect(summaryCells?.[2]?.textContent).toBe('52');
    expect(
      container?.querySelector('select[aria-label="Filter toko"] option[value="' + STORE_ID + '"]'),
    ).not.toBeNull();
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/admin/'))).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/reports/monthly?')),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/reports/monthly?')),
    ).toHaveLength(1);
  });

  it('paginates shift details at 50 rows and preserves stable row identities for multiple shifts', async () => {
    await mount();
    const detailTab = [...container!.querySelectorAll('.monthly-report-tabs button')].find(
      (button) => button.textContent?.includes('Detail shift'),
    );
    expect(detailTab).toBeDefined();
    await act(async () => detailTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container?.querySelectorAll('tbody tr')).toHaveLength(50);
    const next = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Berikutnya'),
    );
    expect(next).toBeDefined();
    await act(async () => next?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container?.textContent).toContain('Menampilkan 51–52 dari 52 rincian');
  });

  it('provides Supervisor-only report route role through an explicit component prop', async () => {
    await mount('SUPERVISOR');
    expect(container?.textContent).toContain('LAPORAN · SUPERVISOR');
  });

  it('loads the Admin report and its master-data filter options on the Admin page only', async () => {
    await mount('ADMIN');

    expect(container?.textContent).toContain('LAPORAN · ADMIN');
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/admin/stores'))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/admin/employees'))).toBe(
      true,
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/reports/monthly?')),
    ).toHaveLength(1);
  });

  it('applies filter changes to the report API query', async () => {
    await mount();
    const storeSelect = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter toko"]',
    );
    expect(storeSelect).not.toBeNull();

    await act(async () => {
      storeSelect!.value = STORE_ID;
      storeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(`/reports/monthly?month=${REPORT_MONTH}&storeId=${STORE_ID}`),
      ),
    ).toBe(true);
  });
});
