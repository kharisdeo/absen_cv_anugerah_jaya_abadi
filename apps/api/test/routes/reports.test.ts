import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { AppError } from '../../src/errors/app-error.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import {
  MonthlyReportService,
  type MonthlyReportRepository,
} from '../../src/modules/report/index.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000701';
const EMPLOYEE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000702';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000703';
const STORE_ID = '00000000-0000-4000-8000-000000000704';
const NOW = new Date('2026-10-11T16:59:59.999Z');
const openApps: FastifyInstance[] = [];

function accountId(role: UserRole): string {
  if (role === UserRole.ADMIN) return ADMIN_ID;
  if (role === UserRole.SUPERVISOR) return SUPERVISOR_ID;
  return EMPLOYEE_ACCOUNT_ID;
}

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: accountId(role),
    username: role.toLowerCase(),
    role,
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
    deviceBindingStatus: role === UserRole.ADMIN ? null : DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
  };
}

function makeSession(role: UserRole): AuthenticatedSession {
  const user = publicUser(role);
  return {
    user,
    principal: {
      userAccountId: user.id,
      role,
      username: user.username,
      employeeId: user.employeeId,
      deviceBindingId: role === UserRole.ADMIN ? null : '00000000-0000-4000-8000-000000000705',
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `monthly-report-route-${role}`,
      lastSeenAt: NOW,
    },
  };
}

async function harness(includeSecondShift = false) {
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new Error('Unexpected role fixture.');
      const token = `monthly-report-token-${role}`;
      sessions.set(token, makeSession(role));
      return { cookieToken: token, user: publicUser(role) };
    },
    async authenticate(token: string | undefined) {
      const session = token ? sessions.get(token) : undefined;
      if (!session)
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      return session;
    },
    requireRegularAccess() {},
  } as unknown as AuthRoutesOptions['service'];
  const auth = {
    service: authService,
    cookieSecret: 'monthly-report-route-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;

  const reportRow = {
    employeeId: EMPLOYEE_ID,
    employeeName: 'Karyawan A',
    shiftAssignmentId: '00000000-0000-4000-8000-000000000706',
    shiftId: '00000000-0000-4000-8000-000000000707',
    shiftName: 'Pagi',
    shiftBreakMinutes: 30,
    storeId: STORE_ID,
    storeName: 'Toko A',
    date: '2026-10-01',
    isHoliday: false,
    status: 'PRESENT' as const,
    checkInAt: new Date('2026-10-01T01:00:00.000Z'),
    checkOutAt: new Date('2026-10-01T10:00:00.000Z'),
    checkInValidationStatus: 'VALID' as const,
    checkOutValidationStatus: 'APPROVED' as const,
    hasPendingAttendance: false,
    hasLateCheckIn: false,
    pendingValidationStatus: null,
    hasRejectedAttendance: false,
    lateMinutesAfterScheduledStart: null,
    approvedOvertimeMinutes: 60,
  };
  const reportRows = includeSecondShift
    ? [
        reportRow,
        {
          ...reportRow,
          shiftAssignmentId: '00000000-0000-4000-8000-000000000708',
          shiftId: '00000000-0000-4000-8000-000000000709',
          shiftName: 'Sore',
        },
      ]
    : [reportRow];
  const repository: MonthlyReportRepository = {
    listSupervisorStoreIds: vi.fn(async () => [STORE_ID]),
    monthlyReport: vi.fn(async () => reportRows),
  };
  const events: unknown[] = [];
  const audit = {
    async record(event: unknown) {
      events.push(event);
      return {} as never;
    },
  };
  const exporter = vi.fn(async () => Buffer.from('xlsx-test-content'));
  const service = new MonthlyReportService(repository, audit, exporter, () => NOW);
  const app = await buildApp({ logger: false, auth, monthlyReports: { service } });
  openApps.push(app);
  return { app, repository, events, exporter };
}

async function login(app: FastifyInstance, role: UserRole): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { identifier: role, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookie) throw new Error('Monthly report test login did not set a cookie.');
  return cookie.split(';', 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('monthly report routes', () => {
  it('requires a session and restricts reports to Admin/Supervisor', async () => {
    const { app, repository } = await harness();
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly?month=2026-10',
    });
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const employee = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly?month=2026-10',
      headers: { cookie: employeeCookie },
    });
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const supervisor = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/monthly?month=2026-10&storeId=${STORE_ID}`,
      headers: { cookie: supervisorCookie },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(employee.statusCode).toBe(403);
    expect(supervisor.statusCode).toBe(200);
    expect(supervisor.json().summary).toHaveLength(1);
    expect(repository.listSupervisorStoreIds).toHaveBeenCalledWith(SUPERVISOR_ID);
    expect(repository.monthlyReport).toHaveBeenCalledWith({
      filter: { month: '2026-10', storeId: STORE_ID },
      today: '2026-10-11',
      scopedStoreIds: [STORE_ID],
    });
    for (const response of [anonymous, employee, supervisor]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('counts a shared calendar date once while returning each shift in daily details', async () => {
    const { app, repository } = await harness(true);
    const cookie = await login(app, UserRole.SUPERVISOR);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/monthly?month=2026-10&storeId=${STORE_ID}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.listSupervisorStoreIds).toHaveBeenCalledWith(SUPERVISOR_ID);
    expect(repository.monthlyReport).toHaveBeenCalledWith({
      filter: { month: '2026-10', storeId: STORE_ID },
      today: '2026-10-11',
      scopedStoreIds: [STORE_ID],
    });

    const body = response.json();
    expect(body.filters).toEqual({ storeId: STORE_ID, employeeId: null });
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({ employeeId: EMPLOYEE_ID, workDays: 1 });
    expect(body.dailyDetails).toHaveLength(2);
    expect(body.dailyDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeId: EMPLOYEE_ID,
          date: '2026-10-01',
          shift: {
            assignmentId: '00000000-0000-4000-8000-000000000706',
            id: '00000000-0000-4000-8000-000000000707',
            name: 'Pagi',
          },
        }),
        expect.objectContaining({
          employeeId: EMPLOYEE_ID,
          date: '2026-10-01',
          shift: {
            assignmentId: '00000000-0000-4000-8000-000000000708',
            id: '00000000-0000-4000-8000-000000000709',
            name: 'Sore',
          },
        }),
      ]),
    );
  });

  it('rejects malformed and unknown query filters without calling report queries', async () => {
    const { app, repository } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const invalids = await Promise.all(
      [
        '/api/v1/reports/monthly',
        '/api/v1/reports/monthly?month=2026-13',
        '/api/v1/reports/monthly?month=2026-10&storeId=nope',
        '/api/v1/reports/monthly?month=2026-10&unexpected=true',
      ].map((url) => app.inject({ method: 'GET', url, headers: { cookie } })),
    );
    expect(invalids.every((response) => response.statusCode === 400)).toBe(true);
    expect(repository.monthlyReport).not.toHaveBeenCalled();
  });

  it('exports an XLSX attachment with no-store and appends a minimal audit event', async () => {
    const { app, repository, events, exporter } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/monthly/export?month=2026-10&employeeId=${EMPLOYEE_ID}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toContain('rekap-absensi-2026-10.xlsx');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('xlsx-test-content');
    expect(exporter).toHaveBeenCalledOnce();
    expect(repository.monthlyReport).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'monthly_report.export',
      entityType: 'monthly_report',
      after: { month: '2026-10', employeeId: EMPLOYEE_ID },
      clientIp: '127.0.0.1',
    });
  });
});
