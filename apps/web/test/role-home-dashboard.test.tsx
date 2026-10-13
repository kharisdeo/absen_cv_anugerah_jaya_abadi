// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminDashboard,
  DashboardSummary,
  DashboardTrendItem,
} from '../src/api/admin-dashboard-api.js';
import type {
  EmployeeDashboard,
  EmployeeDashboardTodayItem,
} from '../src/api/employee-dashboard-api.js';
import { EmployeeScheduleResults } from '../src/pages/EmployeeSchedulePage.js';
import {
  EmployeeTodaySummary,
  SupervisorDashboardResults,
  SupervisorDashboardSummary,
} from '../src/pages/RoleHome.js';
import type { EmployeeDashboardLoadState } from '../src/pages/use-employee-dashboard.js';
import type { AdminDashboardDataState } from '../src/pages/use-admin-dashboard.js';

const employeeItem: EmployeeDashboardTodayItem = {
  employeeId: '00000000-0000-4000-8000-000000000201',
  employeeName: 'Nama pribadi tidak ditampilkan',
  shiftAssignmentId: '00000000-0000-4000-8000-000000000202',
  shiftId: '00000000-0000-4000-8000-000000000203',
  shiftName: 'Shift Pagi',
  scheduledStartTime: '08:00:00',
  scheduledEndTime: '17:00:00',
  store: { id: '00000000-0000-4000-8000-000000000204', name: 'Toko Utama' },
  date: '2026-10-11',
  status: 'NOT_CHECKED_IN',
  checkInAt: null,
  checkOutAt: null,
  minutesAfterScheduledStart: null,
};

function employeeDashboard(
  today: readonly EmployeeDashboardTodayItem[] = [employeeItem],
): EmployeeDashboard {
  return {
    today,
    history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
    requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
  };
}

const emptySummary: DashboardSummary = {
  scheduledShifts: 0,
  present: 0,
  late: 0,
  notCheckedIn: 0,
  absent: 0,
  leave: 0,
  sick: 0,
  annualLeave: 0,
  waitingVerification: 0,
  pendingRequests: 0,
};

function addDays(value: string, count: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function adminDashboard(summary: DashboardSummary = emptySummary): AdminDashboard {
  const trend: readonly DashboardTrendItem[] = Array.from({ length: 30 }, (_, index) => ({
    date: addDays('2026-09-12', index),
    ...summary,
  }));
  return {
    summary,
    notCheckedIn: {
      items: [
        {
          employeeId: '00000000-0000-4000-8000-000000000301',
          employeeName: 'Detail karyawan rahasia',
          shiftAssignmentId: '00000000-0000-4000-8000-000000000302',
          shiftId: '00000000-0000-4000-8000-000000000303',
          shiftName: 'Shift Rahasia',
          scheduledStartTime: '08:00:00',
          scheduledEndTime: '17:00:00',
          store: { id: '00000000-0000-4000-8000-000000000304', name: 'Toko Rahasia' },
          date: '2026-10-11',
          status: 'NOT_CHECKED_IN',
          checkInAt: null,
          checkOutAt: null,
          minutesAfterScheduledStart: null,
        },
      ],
      page: 1,
      pageSize: 25,
      hasNextPage: false,
    },
    trend,
    lateRanking: [
      {
        employeeId: '00000000-0000-4000-8000-000000000305',
        employeeName: 'Ranking rahasia',
        lateCount: 1,
        lateDays: 1,
        totalMinutesAfterScheduledStart: 4,
      },
    ],
  };
}

function employeeState(today: readonly EmployeeDashboardTodayItem[]): EmployeeDashboardLoadState {
  return { status: 'loaded', dashboard: employeeDashboard(today) };
}

function supervisorState(summary: DashboardSummary = emptySummary): AdminDashboardDataState {
  return { status: 'loaded', dashboard: adminDashboard(summary), refreshing: false };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

beforeEach(() => {
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
});

function renderToMarkup(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

describe('ringkasan dashboard RoleHome', () => {
  it('Employee menampilkan loading, error aman, empty dari today[], dan data shift server', () => {
    const loading = renderToMarkup(
      <EmployeeScheduleResults state={{ status: 'loading' }} onRetry={() => undefined} />,
    );
    const error = renderToMarkup(
      <EmployeeScheduleResults
        state={{ status: 'error', error: new Error('detail server rahasia') }}
        onRetry={() => undefined}
      />,
    );
    const empty = renderToMarkup(
      <EmployeeScheduleResults state={employeeState([])} onRetry={() => undefined} />,
    );
    const success = renderToMarkup(
      <EmployeeScheduleResults state={employeeState([employeeItem])} onRetry={() => undefined} />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('Memuat jadwal hari ini');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Coba lagi');
    expect(error).not.toContain('detail server rahasia');
    expect(empty).toContain('Tidak ada jadwal shift hari ini');
    expect(success).toContain('Shift Pagi');
    expect(success).toContain('Belum absen masuk');
    expect(success).toContain('11 Okt 2026');
    expect(success).toContain('08:00 – 17:00');
    expect(success).not.toContain('Tidak hadir');
    expect(success).not.toContain('Nama pribadi');
  });

  it('Supervisor menampilkan loading/error, zero dari antrean kosong, atau hanya dua summary', () => {
    const retry = vi.fn();
    const loading = renderToMarkup(
      <SupervisorDashboardResults state={{ status: 'loading' }} onRetry={retry} />,
    );
    const error = renderToMarkup(
      <SupervisorDashboardResults
        state={{ status: 'error', error: new Error('detail server rahasia') }}
        onRetry={retry}
      />,
    );
    const empty = renderToMarkup(
      <SupervisorDashboardResults state={supervisorState()} onRetry={retry} />,
    );
    const summary: DashboardSummary = {
      ...emptySummary,
      waitingVerification: 4,
      pendingRequests: 2,
    };
    const success = renderToMarkup(
      <SupervisorDashboardResults state={supervisorState(summary)} onRetry={retry} />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('Memuat ringkasan tim');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Coba lagi');
    expect(error).not.toContain('detail server rahasia');
    expect(empty.match(/dashboard-summary-value/g)).toHaveLength(2);
    expect(empty).toContain('>0</p>');
    expect(success).toContain('>4</p>');
    expect(success).toContain('>2</p>');
    expect(success).not.toContain('Detail karyawan rahasia');
    expect(success).not.toContain('Ranking rahasia');
    expect(success).not.toContain('Toko Rahasia');
  });

  it('Employee hook memanggil endpoint self dashboard tanpa tanggal bisnis dari browser', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(employeeDashboard()));
    vi.stubGlobal('fetch', fetchMock);
    if (!container) throw new Error('DOM test container was not initialized');
    root = createRoot(container);

    await act(async () => {
      root?.render(<EmployeeTodaySummary />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me/dashboard',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
    expect(container.textContent).toContain('Shift Pagi');
    expect(container.textContent).toContain('11 Okt 2026');
  });

  it('Supervisor hook omits date/store/shift scope and can retry a safe API error', async () => {
    const summary: DashboardSummary = {
      ...emptySummary,
      waitingVerification: 4,
      pendingRequests: 2,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 'FORBIDDEN', detail: 'private detail' }, 403))
      .mockResolvedValueOnce(jsonResponse(adminDashboard(summary)));
    vi.stubGlobal('fetch', fetchMock);
    if (!container) throw new Error('DOM test container was not initialized');
    root = createRoot(container);

    await act(async () => {
      root?.render(<SupervisorDashboardSummary />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Anda tidak memiliki akses');
    expect(container.textContent).not.toContain('private detail');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Coba lagi',
    );
    if (!retry) throw new Error('Expected accessible retry button');
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toBe('/api/v1/dashboard?page=1&pageSize=25');
      expect(String(url)).not.toContain('date=');
      expect(String(url)).not.toContain('storeId=');
      expect(String(url)).not.toContain('shiftId=');
    }
    expect(container.textContent).toContain('Verifikasi absensi');
    expect(container.textContent).toContain('Pengajuan tim');
    expect(container.textContent).toContain('4');
    expect(container.textContent).toContain('2');
    expect(container.textContent).not.toContain('Detail karyawan rahasia');
    expect(container.textContent).not.toContain('Ranking rahasia');
  });
});
