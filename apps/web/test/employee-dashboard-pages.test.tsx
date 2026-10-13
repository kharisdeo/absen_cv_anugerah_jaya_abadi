import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type {
  EmployeeDashboard,
  EmployeeDashboardTodayItem,
} from '../src/api/employee-dashboard-api.js';
import { EmployeeHistoryResults } from '../src/pages/EmployeeHistoryPage.js';
import { EmployeeLeavePage, EmployeeLeaveRequestSummary } from '../src/pages/EmployeeLeavePage.js';
import {
  EmployeeScheduleCard,
  EmployeeScheduleResults,
} from '../src/pages/EmployeeSchedulePage.js';
import type { EmployeeDashboardLoadState } from '../src/pages/use-employee-dashboard.js';
import { RolePage } from '../src/app/RolePage.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';
import {
  INITIAL_EMPLOYEE_HISTORY_FILTER,
  reduceEmployeeHistoryFilter,
} from '../src/pages/employee-history-filter.js';

const todayShift: EmployeeDashboardTodayItem = {
  employeeId: '00000000-0000-4000-8000-000000000201',
  employeeName: 'Nama Pribadi Tidak Ditampilkan',
  shiftAssignmentId: '00000000-0000-4000-8000-000000000202',
  shiftId: '00000000-0000-4000-8000-000000000203',
  shiftName: 'Shift malam',
  scheduledStartTime: '22:00:00',
  scheduledEndTime: '06:00:00',
  store: { id: '00000000-0000-4000-8000-000000000204', name: 'Toko Jakarta' },
  date: '2026-10-11',
  status: 'NOT_CHECKED_IN',
  checkInAt: null,
  checkOutAt: null,
  minutesAfterScheduledStart: null,
};

const emptyDashboard: EmployeeDashboard = {
  today: [],
  history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
  requests: { items: [], page: 1, pageSize: 5, hasNextPage: false },
};

function loadedDashboard(overrides: Partial<EmployeeDashboard> = {}): EmployeeDashboardLoadState {
  return { status: 'loaded', dashboard: { ...emptyDashboard, ...overrides } };
}

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000205',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000201',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): SessionState {
  return { status: 'authenticated', user: user(role) };
}

describe('employee dashboard pages', () => {
  it('maps the existing employee routes to their screens and rejects other roles', async () => {
    const routes = ['/employee/history', '/employee/schedule', '/employee/leave'] as const;
    const expectedLoadingCopy = [
      'Memuat riwayat absensi Anda',
      'Memuat jadwal hari ini',
      'Saldo cuti belum tersedia',
    ];

    for (const [index, route] of routes.entries()) {
      expect(getRoleRoute(route)?.role).toBe('EMPLOYEE');
      expect(ROLE_NAVIGATION.EMPLOYEE.some((item) => item.to === route)).toBe(true);
      expect(decideDirectRouteAccess(session('EMPLOYEE'), route)).toBe('allow');
      expect(decideDirectRouteAccess(session('SUPERVISOR'), route)).toBe('wrong-role');
      expect(decideDirectRouteAccess(session('ADMIN'), route)).toBe('wrong-role');

      const html = await renderToResolvedMarkup(
        <MemoryRouter initialEntries={[route]}>
          <RolePage role="EMPLOYEE" route={route} />
        </MemoryRouter>,
      );
      expect(html).toContain(expectedLoadingCopy[index]!);
      if (route === '/employee/history') {
        expect(html).toContain('Dari tanggal');
        expect(html).toContain('Sampai tanggal');
        expect(html).toContain('type="date"');
      }
    }
  });

  it('resets server-side history pagination on date changes and clears both filters on reset', () => {
    const pageThree = reduceEmployeeHistoryFilter(INITIAL_EMPLOYEE_HISTORY_FILTER, {
      type: 'page',
      value: 3,
    });
    const fromChanged = reduceEmployeeHistoryFilter(pageThree, {
      type: 'from',
      value: '2026-10-01',
    });
    expect(fromChanged).toEqual({ page: 1, from: '2026-10-01', to: '' });

    const toChanged = reduceEmployeeHistoryFilter(
      { ...fromChanged, page: 4 },
      { type: 'to', value: '2026-10-31' },
    );
    expect(toChanged).toEqual({ page: 1, from: '2026-10-01', to: '2026-10-31' });
    expect(reduceEmployeeHistoryFilter(toChanged, { type: 'reset' })).toEqual({
      page: 1,
      from: '',
      to: '',
    });
  });

  it('renders loading, retryable safe errors, and empty history states accessibly', () => {
    const loading = renderToStaticMarkup(
      <EmployeeHistoryResults
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{ status: 'loading' }}
      />,
    );
    const error = renderToStaticMarkup(
      <EmployeeHistoryResults
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{ status: 'error', error: new Error('raw private detail') }}
      />,
    );
    const empty = renderToStaticMarkup(
      <EmployeeHistoryResults
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={loadedDashboard()}
      />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('Memuat riwayat absensi Anda');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Coba lagi');
    expect(error).not.toContain('raw private detail');
    expect(empty).toContain('Belum ada riwayat absensi');
  });

  it('shows check-in/out, server time, location and distinct server validation statuses only', () => {
    const state = loadedDashboard({
      history: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000206',
            date: '2026-10-11',
            type: 'CHECK_IN',
            serverTime: '2026-10-11T15:00:00.000Z',
            validationStatus: 'PENDING_OFFLINE',
            store: { id: '00000000-0000-4000-8000-000000000204', name: 'Toko Jakarta' },
            shift: { id: '00000000-0000-4000-8000-000000000203', name: 'Shift malam' },
          },
          {
            id: '00000000-0000-4000-8000-000000000207',
            date: '2026-10-11',
            type: 'CHECK_OUT',
            serverTime: '2026-10-12T00:00:00.000Z',
            validationStatus: 'PENDING_VERIFICATION',
            store: null,
            shift: null,
          },
        ],
        page: 1,
        pageSize: 20,
        hasNextPage: false,
      },
    });
    const html = renderToStaticMarkup(
      <EmployeeHistoryResults
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={state}
      />,
    );

    expect(html).toContain('ABSEN MASUK');
    expect(html).toContain('ABSEN PULANG');
    expect(html).toContain('Waktu server');
    expect(html).toContain('Shift malam');
    expect(html).toContain('Toko Jakarta');
    expect(html).toContain('Absen tertunda');
    expect(html).toContain('Perlu verifikasi');
    expect(html).toContain('Menunggu sinkronisasi');
    expect(html).toContain('Menunggu pemeriksaan');
    expect(html).not.toContain('Nama Pribadi');
    expect(html).not.toContain('employeeId');
    expect(html).not.toContain('GPS');
    expect(html).not.toContain('selfie');
    expect(html).not.toContain('latitude');
  });

  it('renders a next-calendar-day end for an overnight wall-clock shift', () => {
    const html = renderToStaticMarkup(<EmployeeScheduleCard item={todayShift} />);
    expect(html).toContain('22:00 – 06:00');
    expect(html).toContain('Selesai pada hari kalender berikutnya, 12 Okt 2026');
    expect(html).toContain('Belum absen masuk');
    expect(html).toContain('Toko Jakarta');
    expect(html).not.toContain('Nama Pribadi Tidak Ditampilkan');
    expect(html).not.toContain('Z</dd>');
  });

  it('has a total status presentation for NOT_CHECKED_IN and REQUEST_PENDING without daily enum casts', () => {
    const html = renderToStaticMarkup(
      <EmployeeScheduleResults
        onRetry={() => undefined}
        state={loadedDashboard({
          today: [
            todayShift,
            {
              ...todayShift,
              shiftAssignmentId: '00000000-0000-4000-8000-000000000208',
              status: 'REQUEST_PENDING',
            },
          ],
        })}
      />,
    );
    expect(html).toContain('Belum absen masuk');
    expect(html).toContain('Pengajuan menunggu keputusan');
    expect(html).not.toContain('TypeError');
  });

  it('renders empty, loading and retryable error schedule states', () => {
    const empty = renderToStaticMarkup(
      <EmployeeScheduleResults onRetry={() => undefined} state={loadedDashboard()} />,
    );
    const loading = renderToStaticMarkup(
      <EmployeeScheduleResults onRetry={() => undefined} state={{ status: 'loading' }} />,
    );
    const retry = vi.fn();
    const error = renderToStaticMarkup(
      <EmployeeScheduleResults
        onRetry={retry}
        state={{ status: 'error', error: new Error('private backend detail') }}
      />,
    );

    expect(empty).toContain('Tidak ada jadwal shift hari ini');
    expect(loading).toContain('role="status"');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Coba lagi');
    expect(error).not.toContain('private backend detail');
  });

  it('states that balance is unavailable, provides the exact request link, and summarizes only statuses', () => {
    const loadingPage = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/employee/leave']}>
        <EmployeeLeavePage />
      </MemoryRouter>,
    );
    const requestState = loadedDashboard({
      requests: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000209',
            requestType: 'ANNUAL_LEAVE',
            startDate: '2026-10-20',
            endDate: '2026-10-21',
            status: 'PENDING',
            requestedAt: '2026-10-11T15:00:00.000Z',
            decisionAt: null,
          },
        ],
        page: 1,
        pageSize: 5,
        hasNextPage: false,
      },
    });
    const summary = renderToStaticMarkup(
      <MemoryRouter>
        <EmployeeLeaveRequestSummary onRetry={() => undefined} state={requestState} />
      </MemoryRouter>,
    );
    const errorRetry = renderToStaticMarkup(
      <EmployeeLeaveRequestSummary
        onRetry={() => undefined}
        state={{ status: 'error', error: new Error('private request detail') }}
      />,
    );

    expect(loadingPage).toContain('Saldo cuti belum tersedia');
    expect(loadingPage).toContain('kuota dan aturan akrual/carry-over belum ditetapkan');
    expect(loadingPage).toContain('href="/employee/requests"');
    expect(loadingPage).not.toContain('Saldo cuti: 0');
    expect(summary).toContain('Cuti tahunan');
    expect(summary).toContain('Menunggu keputusan');
    expect(summary).not.toContain('private reason');
    expect(summary).not.toContain('attachment-url');
    expect(errorRetry).toContain('Coba lagi');
    expect(errorRetry).not.toContain('private request detail');
  });
});
