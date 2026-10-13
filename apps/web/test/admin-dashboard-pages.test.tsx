import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import {
  AdminDashboardApiError,
  type AdminDashboard,
  type DashboardTrendItem,
} from '../src/api/admin-dashboard-api.js';
import type { StoreDto } from '../src/api/admin-stores-api.js';
import type { WorkShiftDto } from '../src/api/admin-shifts-api.js';
import { RolePage } from '../src/app/RolePage.js';
import { getRoleRoute, ROLE_NAVIGATION } from '../src/app/role-navigation.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';
import {
  INITIAL_ADMIN_DASHBOARD_FILTERS,
  reduceAdminDashboardFilters,
} from '../src/pages/admin-dashboard-model.js';
import { AdminDashboardView } from '../src/pages/AdminDashboardPage.js';
import type {
  AdminDashboardDataState,
  AdminDashboardOptionsState,
} from '../src/pages/use-admin-dashboard.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000101';
const SHIFT_ID = '00000000-0000-4000-8000-000000000102';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000103';
const STORE_ID = '00000000-0000-4000-8000-000000000104';

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
  waitingVerification: 1,
  pendingRequests: 0,
};

function trend(): readonly DashboardTrendItem[] {
  return Array.from({ length: 30 }, (_, index) => ({
    date: addDays('2026-09-12', index),
    ...summary,
  }));
}

function dashboard(): AdminDashboard {
  return {
    summary,
    notCheckedIn: {
      items: [
        {
          employeeId: ADMIN_ID,
          employeeName: 'Karyawan Belum Masuk',
          shiftAssignmentId: ASSIGNMENT_ID,
          shiftId: SHIFT_ID,
          shiftName: 'Shift Pagi',
          scheduledStartTime: '08:00:00',
          scheduledEndTime: '17:00:00',
          store: { id: STORE_ID, name: 'Toko Utama' },
          date: '2026-10-11',
          status: 'NOT_CHECKED_IN',
          checkInAt: null,
          checkOutAt: null,
          minutesAfterScheduledStart: null,
        },
        {
          employeeId: '00000000-0000-4000-8000-000000000105',
          employeeName: 'Karyawan Tidak Hadir',
          shiftAssignmentId: '00000000-0000-4000-8000-000000000106',
          shiftId: SHIFT_ID,
          shiftName: 'Shift Pagi',
          scheduledStartTime: '08:00:00',
          scheduledEndTime: '17:00:00',
          store: null,
          date: '2026-10-11',
          status: 'ABSENT',
          checkInAt: null,
          checkOutAt: null,
          minutesAfterScheduledStart: null,
        },
      ],
      page: 1,
      pageSize: 25,
      hasNextPage: false,
    },
    trend: trend(),
    lateRanking: [
      {
        employeeId: ADMIN_ID,
        employeeName: 'Karyawan Terlambat',
        lateCount: 3,
        lateDays: 2,
        totalMinutesAfterScheduledStart: 36.5,
      },
    ],
  };
}

function store(isActive: boolean): StoreDto {
  return {
    id: STORE_ID,
    name: 'Toko Arsip',
    address: null,
    latitude: -6.2,
    longitude: 106.8,
    radiusMeters: 10,
    accuracyLimitMeters: 30,
    wifiPublicIp: null,
    isActive,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function shift(isActive: boolean): WorkShiftDto {
  return {
    id: SHIFT_ID,
    name: 'Shift Arsip',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    lateToleranceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    isActive,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const loadedOptions: AdminDashboardOptionsState = {
  stores: { status: 'loaded', items: [store(false)], error: null },
  shifts: { status: 'loaded', items: [shift(false)], error: null },
};

function view(state: AdminDashboardDataState, options = loadedOptions, date = ''): string {
  return renderToStaticMarkup(
    <AdminDashboardView
      filters={{ ...INITIAL_ADMIN_DASHBOARD_FILTERS, date }}
      onFilterChange={() => undefined}
      onPageChange={() => undefined}
      onRefresh={() => undefined}
      onRetryOptions={() => undefined}
      options={options}
      state={state}
    />,
  );
}

function authUser(role: UserRole): AuthUser {
  return {
    id: ADMIN_ID,
    username: 'admin',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000107',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): SessionState {
  return { status: 'authenticated', user: authUser(role) };
}

describe('Admin dashboard route and page', () => {
  it('uses the existing exact /admin route and rejects Employee/Supervisor direct access', async () => {
    expect(getRoleRoute('/admin')?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some(({ to }) => to === '/admin')).toBe(true);
    expect(decideDirectRouteAccess(session('ADMIN'), '/admin')).toBe('allow');
    expect(decideDirectRouteAccess(session('SUPERVISOR'), '/admin')).toBe('wrong-role');
    expect(decideDirectRouteAccess(session('EMPLOYEE'), '/admin')).toBe('wrong-role');

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin']}>
        <RolePage role="ADMIN" route="/admin" />
      </MemoryRouter>,
    );
    expect(html).toContain('Memuat dashboard Admin');
    expect(html).toContain('Hari ini (tanggal server)');
    expect(html).toContain('Ringkasan kehadiran');
  });

  it('resets the server-side absent-list page when any dashboard filter changes', () => {
    const pageFour = reduceAdminDashboardFilters(INITIAL_ADMIN_DASHBOARD_FILTERS, {
      type: 'page',
      value: 4,
    });
    expect(reduceAdminDashboardFilters(pageFour, { type: 'date', value: '2026-10-11' })).toEqual({
      date: '2026-10-11',
      storeId: '',
      shiftId: '',
      page: 1,
    });
    const pageThree = { ...pageFour, page: 3 };
    expect(reduceAdminDashboardFilters(pageThree, { type: 'store', value: STORE_ID }).page).toBe(1);
    expect(
      reduceAdminDashboardFilters(
        { ...pageThree, shiftId: SHIFT_ID },
        {
          type: 'shift',
          value: '00000000-0000-4000-8000-000000000108',
        },
      ).page,
    ).toBe(1);
  });

  it('renders accessible loading, server-validation error, and empty states', () => {
    const loading = view({ status: 'loading' });
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');

    const futureDateError = view(
      {
        status: 'error',
        error: new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT'),
      },
      loadedOptions,
      '2027-01-01',
    );
    expect(futureDateError).toContain('role="alert"');
    expect(futureDateError).toContain('tanggal bisnis server');
    expect(futureDateError).toContain('type="date"');
    expect(futureDateError).toContain('Coba lagi');

    const emptyDashboard: AdminDashboard = {
      ...dashboard(),
      summary: {
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
      },
      notCheckedIn: { items: [], page: 1, pageSize: 25, hasNextPage: false },
      lateRanking: [],
    };
    const empty = view({ status: 'loaded', dashboard: emptyDashboard, refreshing: false });
    expect(empty).toContain('Tidak ada jadwal untuk filter ini');
    expect(empty).toContain('Belum ada peringkat keterlambatan');
    expect(empty).toContain('Tidak ada karyawan dalam daftar');
  });

  it('renders API KPI/status mapping, accessible trend data and ranking labels without net-grace claims', () => {
    const html = view({ status: 'loaded', dashboard: dashboard(), refreshing: false });
    for (const label of [
      'Hadir',
      'Terlambat',
      'Belum check-in',
      'Tidak hadir',
      'Izin',
      'Sakit',
      'Cuti tahunan',
      'Perlu verifikasi',
      'Karyawan Belum Masuk',
      'Karyawan Tidak Hadir',
      'Belum check-in',
      'Tidak hadir',
      'Angka tren kehadiran dan keterlambatan selama 30 hari',
      '11 Oktober 2026',
      '36,5 menit',
      'termasuk toleransi',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('total menit sejak jadwal mulai termasuk toleransi');
    expect(html).toContain('Bukan menit bersih setelah toleransi');
  });

  it('keeps inactive store/shift choices visible and maps option failures without server detail', () => {
    const html = view({ status: 'loaded', dashboard: dashboard(), refreshing: false });
    expect(html).toContain('Toko Arsip (nonaktif)');
    expect(html).toContain('Shift Arsip (nonaktif)');
    expect(html).toContain('Semua toko');
    expect(html).toContain('Semua shift');

    const erroredOptions: AdminDashboardOptionsState = {
      stores: {
        status: 'error',
        items: [],
        error: { code: 'INTERNAL_SERVER_ERROR', detail: 'private stack' },
      },
      shifts: {
        status: 'error',
        items: [],
        error: { code: 'INTERNAL_SERVER_ERROR', detail: 'private stack' },
      },
    };
    const errorHtml = view(
      { status: 'loaded', dashboard: dashboard(), refreshing: false },
      erroredOptions,
    );
    expect(errorHtml).toContain('Daftar toko belum dapat dimuat');
    expect(errorHtml).toContain('Daftar shift belum dapat dimuat');
    expect(errorHtml).toContain('Coba lagi');
    expect(errorHtml).not.toContain('private stack');
  });
});
