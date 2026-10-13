import { describe, expect, it, vi } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import { DashboardService, type DashboardRepository } from '../../src/modules/dashboard/index.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000501';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000502';

function principal(role: UserRole, employeeId: string | null = null): AuthPrincipal {
  return {
    userAccountId: ACCOUNT_ID,
    role,
    username: role.toLowerCase(),
    employeeId,
    deviceBindingId: null,
    deviceBindingStatus: null,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: 'dashboard-test-session',
    lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
  };
}

describe('DashboardService', () => {
  it('uses the server WIB calendar date on both sides of UTC midnight', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(async () => ({
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
        trend: [],
        lateRanking: [],
      })),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
      })),
    };

    for (const [instant, expected] of [
      ['2026-10-10T16:59:59.999Z', '2026-10-10'],
      ['2026-10-10T17:00:00.000Z', '2026-10-11'],
    ] as const) {
      const service = new DashboardService(repository, () => new Date(instant));
      await service.adminDashboard(principal(UserRole.ADMIN));
      expect(vi.mocked(repository.adminDashboard).mock.lastCall?.[0]).toMatchObject({
        filter: { date: expected },
        today: expected,
      });
    }
  });

  it('uses the configured business timezone rather than a browser or process-local date', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(async () => ({
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
        trend: [],
        lateRanking: [],
      })),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
      })),
    };
    const service = new DashboardService(
      repository,
      () => new Date('2026-10-11T06:00:00.000Z'),
      'America/Los_Angeles',
    );

    await service.adminDashboard(principal(UserRole.ADMIN));

    expect(vi.mocked(repository.adminDashboard).mock.lastCall?.[0]).toMatchObject({
      filter: { date: '2026-10-10' },
      today: '2026-10-10',
    });
  });

  it('rejects impossible calendar dates and unbounded pagination before repository access', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(async () => ({
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
        trend: [],
        lateRanking: [],
      })),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
      })),
    };
    const service = new DashboardService(repository, () => new Date('2026-10-11T03:00:00.000Z'));

    await expect(
      service.adminDashboard(principal(UserRole.ADMIN), { date: '2026-02-30' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DASHBOARD_INPUT' });
    await expect(
      service.adminDashboard(principal(UserRole.ADMIN), { date: '2026-10-12' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DASHBOARD_INPUT' });
    await expect(
      service.adminDashboard(principal(UserRole.ADMIN), { pageSize: 51 }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DASHBOARD_INPUT' });
    expect(repository.adminDashboard).not.toHaveBeenCalled();
  });

  it('keeps personal status self-scoped and does not invent a leave balance', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
      })),
    };
    const service = new DashboardService(repository, () => new Date('2026-10-11T03:00:00.000Z'));

    const result = await service.employeeDashboard(principal(UserRole.EMPLOYEE, EMPLOYEE_ID));

    expect(repository.employeeDashboard).toHaveBeenCalledWith({
      userAccountId: ACCOUNT_ID,
      employeeId: EMPLOYEE_ID,
      date: '2026-10-11',
      historyPage: 1,
      historyPageSize: 20,
      requestPage: 1,
      requestPageSize: 20,
    });
    expect(result).not.toHaveProperty('leaveBalance');
    await expect(service.employeeDashboard(principal(UserRole.ADMIN))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('passes optional history bounds without changing today or request pagination', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 2, pageSize: 10, hasNextPage: false },
        requests: { items: [], page: 3, pageSize: 7, hasNextPage: false },
      })),
    };
    const service = new DashboardService(repository, () => new Date('2026-10-11T03:00:00.000Z'));

    await service.employeeDashboard(principal(UserRole.EMPLOYEE, EMPLOYEE_ID), {
      historyPage: 2,
      historyPageSize: 10,
      historyFrom: '2026-10-01',
      historyTo: '2026-10-31',
      requestPage: 3,
      requestPageSize: 7,
    });

    expect(vi.mocked(repository.employeeDashboard).mock.lastCall?.[0]).toMatchObject({
      date: '2026-10-11',
      historyPage: 2,
      historyPageSize: 10,
      historyFrom: '2026-10-01',
      historyTo: '2026-10-31',
      requestPage: 3,
      requestPageSize: 7,
    });
  });

  it('allows a future history bound without changing the server-selected dashboard date', async () => {
    const repository: DashboardRepository = {
      adminDashboard: vi.fn(),
      employeeDashboard: vi.fn(async () => ({
        today: [],
        history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
      })),
    };
    const service = new DashboardService(repository, () => new Date('2026-10-11T03:00:00.000Z'));

    await service.employeeDashboard(principal(UserRole.EMPLOYEE, EMPLOYEE_ID), {
      historyFrom: '2027-01-01',
    });

    expect(vi.mocked(repository.employeeDashboard).mock.lastCall?.[0]).toMatchObject({
      date: '2026-10-11',
      historyFrom: '2027-01-01',
    });
  });

  it.each([
    ['malformed', '2026-2-01', undefined],
    ['impossible', '2026-02-30', undefined],
    ['inverted', '2026-10-12', '2026-10-11'],
  ])(
    'rejects %s employee history dates before repository access',
    async (_case, historyFrom, historyTo) => {
      const repository: DashboardRepository = {
        adminDashboard: vi.fn(),
        employeeDashboard: vi.fn(async () => ({
          today: [],
          history: { items: [], page: 1, pageSize: 20, hasNextPage: false },
          requests: { items: [], page: 1, pageSize: 20, hasNextPage: false },
        })),
      };
      const service = new DashboardService(repository);

      await expect(
        service.employeeDashboard(principal(UserRole.EMPLOYEE, EMPLOYEE_ID), {
          ...(historyFrom === undefined ? {} : { historyFrom }),
          ...(historyTo === undefined ? {} : { historyTo }),
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DASHBOARD_INPUT' });
      expect(repository.employeeDashboard).not.toHaveBeenCalled();
    },
  );
});
