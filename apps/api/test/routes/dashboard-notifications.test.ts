import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import { DashboardService } from '../../src/modules/dashboard/index.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const NOTIFICATION_ID = '00000000-0000-4000-8000-000000000531';
const ACCOUNT_IDS: Record<UserRole, string> = {
  [UserRole.ADMIN]: '00000000-0000-4000-8000-000000000532',
  [UserRole.SUPERVISOR]: '00000000-0000-4000-8000-000000000533',
  [UserRole.EMPLOYEE]: '00000000-0000-4000-8000-000000000534',
};
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000535';
const openApps: FastifyInstance[] = [];

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: ACCOUNT_IDS[role],
    username: role.toLowerCase(),
    role,
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
    deviceBindingStatus: DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): AuthenticatedSession {
  const user = publicUser(role);
  return {
    user,
    principal: {
      userAccountId: user.id,
      role,
      username: user.username,
      employeeId: user.employeeId,
      deviceBindingId: null,
      deviceBindingStatus: DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `dashboard-notification-${role}`,
      lastSeenAt: new Date('2026-10-11T03:00:00.000Z'),
    },
  };
}

async function harness(options: { dashboard?: unknown } = {}) {
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `dashboard-notification-token-${role}`;
      sessions.set(token, session(role));
      return { cookieToken: token, user: publicUser(role) };
    },
    async authenticate(token: string | undefined) {
      const authenticated = token ? sessions.get(token) : undefined;
      if (!authenticated) throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid.');
      return authenticated;
    },
    requireRegularAccess() {},
  } as unknown as AuthRoutesOptions['service'];
  const auth = {
    service: authService,
    cookieSecret: 'dashboard-notification-route-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const dashboardService = {
    adminDashboard: vi.fn(async (actor: { role: UserRole }, filter: unknown) => {
      if (actor.role === UserRole.EMPLOYEE) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Dashboard hanya tersedia untuk Admin dan Supervisor.',
        );
      }
      return { actor: actor.role, filter };
    }),
    employeeDashboard: vi.fn(async (actor: { role: UserRole }, filter: unknown) => {
      if (actor.role !== UserRole.EMPLOYEE) {
        throw new AppError(403, 'FORBIDDEN', 'Status hanya tersedia untuk karyawan.');
      }
      return { today: [], history: { items: [] }, requests: { items: [] }, filter };
    }),
  };
  const notificationService = {
    list: vi.fn(async (actor: { userAccountId: string }, filter: unknown) => ({
      items: [],
      page: 1,
      pageSize: 25,
      hasNextPage: false,
      unreadCount: 3,
      owner: actor.userAccountId,
      filter,
    })),
    markRead: vi.fn(async (actor: { userAccountId: string }, id: string) => ({
      id,
      readAt: '2026-10-11T04:00:00.000Z',
      owner: actor.userAccountId,
    })),
  };
  const app = await buildApp({
    logger: false,
    auth,
    dashboard: { service: (options.dashboard ?? dashboardService) as never },
    notifications: { service: notificationService as never },
  });
  openApps.push(app);

  async function cookieFor(role: UserRole) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { identifier: role, password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookie) throw new Error('Auth test did not set a cookie.');
    return cookie.split(';')[0]!;
  }

  return { app, dashboardService, notificationService, cookieFor };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('dashboard and notification routes', () => {
  it('wires admin dashboard to Admin/Supervisor sessions and employee dashboard to self only', async () => {
    const { app, dashboardService, cookieFor } = await harness();
    const adminCookie = await cookieFor(UserRole.ADMIN);
    const supervisorCookie = await cookieFor(UserRole.SUPERVISOR);
    const employeeCookie = await cookieFor(UserRole.EMPLOYEE);

    for (const cookie of [adminCookie, supervisorCookie]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard?date=2026-10-11&storeId=00000000-0000-4000-8000-000000000514&shiftId=00000000-0000-4000-8000-000000000516',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }
    const forbiddenDashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard',
      headers: { cookie: employeeCookie },
    });
    expect(forbiddenDashboard.statusCode).toBe(403);

    const employeeDashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/me/dashboard?historyPage=2&historyPageSize=10&historyFrom=2026-10-01&historyTo=2026-10-31&requestPageSize=10',
      headers: { cookie: employeeCookie },
    });
    expect(employeeDashboard.statusCode).toBe(200);
    expect(employeeDashboard.headers['cache-control']).toContain('no-store');
    expect(dashboardService.employeeDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        role: UserRole.EMPLOYEE,
        userAccountId: ACCOUNT_IDS[UserRole.EMPLOYEE],
        employeeId: EMPLOYEE_ID,
      }),
      {
        historyPage: 2,
        historyPageSize: 10,
        historyFrom: '2026-10-01',
        historyTo: '2026-10-31',
        requestPageSize: 10,
      },
    );
    const adminEmployeeDashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/me/dashboard',
      headers: { cookie: adminCookie },
    });
    expect(adminEmployeeDashboard.statusCode).toBe(403);
    expect(dashboardService.adminDashboard).toHaveBeenCalledTimes(3);
    expect(dashboardService.employeeDashboard).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown and out-of-range dashboard query parameters before repository/service access', async () => {
    const { app, dashboardService, cookieFor } = await harness();
    const cookie = await cookieFor(UserRole.ADMIN);
    const employeeCookie = await cookieFor(UserRole.EMPLOYEE);

    for (const url of ['/api/v1/dashboard?extra=1', '/api/v1/dashboard?pageSize=51']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(400);
    }
    for (const url of [
      '/api/v1/me/dashboard?unexpected=1',
      '/api/v1/me/dashboard?employeeId=00000000-0000-4000-8000-000000000535',
      '/api/v1/me/dashboard?historyFrom=2026-1-01',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: employeeCookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_DASHBOARD_INPUT' });
    }
    expect(dashboardService.adminDashboard).not.toHaveBeenCalled();
    expect(dashboardService.employeeDashboard).not.toHaveBeenCalled();
  });

  it('accepts either optional employee history date bound independently', async () => {
    const { app, dashboardService, cookieFor } = await harness();
    const employeeCookie = await cookieFor(UserRole.EMPLOYEE);

    for (const [query, expected] of [
      ['historyFrom=2026-10-01', { historyFrom: '2026-10-01' }],
      ['historyTo=2026-10-31', { historyTo: '2026-10-31' }],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/me/dashboard?${query}`,
        headers: { cookie: employeeCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(dashboardService.employeeDashboard).toHaveBeenLastCalledWith(
        expect.objectContaining({ role: UserRole.EMPLOYEE }),
        expected,
      );
    }
  });

  it('returns 400 for a future business date instead of counting future shifts as not checked in', async () => {
    const repository = { adminDashboard: vi.fn(), employeeDashboard: vi.fn() };
    const service = new DashboardService(
      repository as never,
      () => new Date('2026-10-11T03:00:00.000Z'),
    );
    const { app, cookieFor } = await harness({ dashboard: service });
    const cookie = await cookieFor(UserRole.ADMIN);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard?date=2026-10-12',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_DASHBOARD_INPUT' });
    expect(repository.adminDashboard).not.toHaveBeenCalled();
  });

  it('returns per-account unread count and keeps mark-read on the authenticated owner', async () => {
    const { app, notificationService, cookieFor } = await harness();
    const employeeCookie = await cookieFor(UserRole.EMPLOYEE);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?read=UNREAD&page=2&pageSize=10',
      headers: { cookie: employeeCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toContain('no-store');
    expect(list.json()).toMatchObject({ unreadCount: 3, owner: ACCOUNT_IDS[UserRole.EMPLOYEE] });
    expect(notificationService.list).toHaveBeenCalledWith(
      expect.objectContaining({ userAccountId: ACCOUNT_IDS[UserRole.EMPLOYEE] }),
      { read: 'UNREAD', page: 2, pageSize: 10 },
    );

    const marked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: { cookie: employeeCookie, origin: ORIGIN },
    });
    expect(marked.statusCode).toBe(200);
    expect(notificationService.markRead).toHaveBeenCalledWith(
      expect.objectContaining({ userAccountId: ACCOUNT_IDS[UserRole.EMPLOYEE] }),
      NOTIFICATION_ID,
    );
  });

  it('rejects invalid notification filters and cross-origin state changes', async () => {
    const { app, notificationService, cookieFor } = await harness();
    const cookie = await cookieFor(UserRole.SUPERVISOR);

    const invalidFilter = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?read=OTHER',
      headers: { cookie },
    });
    expect(invalidFilter.statusCode).toBe(400);
    const noOrigin = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: { cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(notificationService.markRead).not.toHaveBeenCalled();
  });
});
