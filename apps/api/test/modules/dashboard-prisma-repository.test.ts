import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { UserRole } from '../../src/generated/prisma/enums.js';
import { PrismaDashboardRepository } from '../../src/modules/dashboard/prisma-repository.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000511';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000512';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000513';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000517';
const STORE_A = '00000000-0000-4000-8000-000000000514';
const STORE_B = '00000000-0000-4000-8000-000000000515';
const SHIFT_ID = '00000000-0000-4000-8000-000000000516';

function rawHarness(
  assignments: string[] = [],
  rankingRows: readonly object[] = [],
  employeeTodayRows: readonly object[] = [],
  attendanceRows: readonly object[] = [],
) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => assignments.map((storeId) => ({ storeId }))),
    },
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      queries.push(query);
      if (query.sql.includes('AS dates(work_date)')) {
        const start = new Date('2026-09-12T00:00:00.000Z');
        return Array.from({ length: 30 }, (_unused, index) => {
          const date = new Date(start);
          date.setUTCDate(start.getUTCDate() + index);
          return {
            date: date.toISOString().slice(0, 10),
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
        });
      }
      if (query.sql.includes('"totalMinutesAfterScheduledStart"')) return rankingRows;
      if (query.sql.includes('scheduled_start_time AS "scheduledStartTime"'))
        return employeeTodayRows;
      if (query.sql.includes('"scheduledShifts"')) return [];
      return [];
    }),
    attendance: { findMany: vi.fn(async () => attendanceRows) },
    attendanceRequest: { findMany: vi.fn(async () => []) },
  };
  return { repository: new PrismaDashboardRepository(prisma as never), prisma, queries };
}

const filter = {
  date: '2026-10-11',
  storeId: STORE_A,
  shiftId: SHIFT_ID,
  page: 2,
  pageSize: 1,
};

describe('PrismaDashboardRepository', () => {
  it('ANDs DB-authoritative Supervisor stores with requested store/shift and paginates the absent list', async () => {
    const { repository, prisma, queries } = rawHarness([STORE_A, STORE_B]);

    const result = await repository.adminDashboard({
      actor: { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR },
      filter,
      today: '2026-10-11',
    });

    expect(prisma.supervisorStoreAssignment.findMany).toHaveBeenCalledWith({
      where: { supervisorUserAccountId: SUPERVISOR_ID },
      select: { storeId: true },
    });
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.sql).toContain('sa.store_id IN');
      expect(query.sql).toContain('sa.store_id =');
      expect(query.sql).toContain('sa.work_shift_id =');
      expect(query.sql).toContain('employee_store.employee_id = sa.employee_id');
      expect(query.values).toContain(STORE_A);
      expect(query.values).toContain(STORE_B);
      expect(query.values).toContain(SHIFT_ID);
      expect(query.values).toContain('2026-09-12');
      expect(query.values).toContain('2026-10-11');
    }
    const absentQuery = queries.find((query) =>
      query.sql.includes("status IN ('NOT_CHECKED_IN', 'ABSENT')"),
    );
    expect(absentQuery?.values).toContain(2); // page 2, pageSize 1 => LIMIT 2
    expect(absentQuery?.values).toContain(1); // OFFSET 1
    expect(result).toMatchObject({
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
      notCheckedIn: { items: [], page: 2, pageSize: 1, hasNextPage: false },
      trend: expect.any(Array),
      lateRanking: [],
    });
    expect(result.trend).toHaveLength(30);
    expect(result.trend[0]).toMatchObject({ date: '2026-09-12', scheduledShifts: 0 });
    expect(result.trend[29]).toMatchObject({ date: '2026-10-11', scheduledShifts: 0 });
  });

  it('fails closed with no assigned stores and does not source an absent status from wall-clock cutoff', async () => {
    const { repository, queries } = rawHarness([]);

    const result = await repository.adminDashboard({
      actor: { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR },
      filter: { date: '2026-10-11', page: 1, pageSize: 25 },
      today: '2026-10-11',
    });

    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.sql).toContain('AND (FALSE)');
      expect(query.sql).toContain("WHEN daily.status = 'ABSENT'");
      expect(query.sql).toContain('daily.corrected_by_attendance_correction_id IS NULL');
      expect(query.sql).toContain("ELSE 'NOT_CHECKED_IN'");
      expect(query.sql).not.toContain("INTERVAL '2 hours'");
    }
    expect(result.trend).toHaveLength(30);
    expect(result.trend.every((day) => day.scheduledShifts === 0)).toBe(true);
  });

  it('projects valid check-in without a valid checkout as MISSING_CHECKOUT and keeps pending precedence', async () => {
    const admin = rawHarness();
    await admin.repository.adminDashboard({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      filter: { date: '2026-10-11', page: 1, pageSize: 25 },
      today: '2026-10-11',
    });

    const supervisor = rawHarness([STORE_A]);
    await supervisor.repository.adminDashboard({
      actor: { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR },
      filter: { date: '2026-10-11', page: 1, pageSize: 25 },
      today: '2026-10-11',
    });

    const employee = rawHarness();
    await employee.repository.employeeDashboard({
      userAccountId: ACCOUNT_ID,
      employeeId: EMPLOYEE_ID,
      date: '2026-10-11',
      historyPage: 1,
      historyPageSize: 20,
      requestPage: 1,
      requestPageSize: 20,
    });

    const statusQueries = [...admin.queries, ...supervisor.queries, ...employee.queries];
    expect(statusQueries.length).toBeGreaterThan(0);
    for (const query of statusQueries) {
      const holidayPriority = query.sql.indexOf("WHEN schedule.is_holiday THEN 'HOLIDAY'");
      const pendingPriority = query.sql.indexOf(
        "WHEN COALESCE(attendance.has_pending, FALSE) THEN 'WAITING_VERIFICATION'",
      );
      const validCheckIn = query.sql.indexOf(
        'WHEN COALESCE(attendance.has_valid_check_in, FALSE) THEN',
      );
      const missingCheckout = query.sql.indexOf(
        "WHEN attendance.check_out_at IS NULL THEN 'MISSING_CHECKOUT'",
      );

      expect(holidayPriority).toBeGreaterThanOrEqual(0);
      expect(holidayPriority).toBeLessThan(pendingPriority);
      expect(pendingPriority).toBeLessThan(validCheckIn);
      expect(validCheckIn).toBeLessThan(missingCheckout);
      expect(query.sql).toContain(
        "WHERE attendance.type = 'CHECK_OUT' AND attendance.validation_status IN ('VALID', 'APPROVED')",
      );
      expect(query.sql).toContain("WHEN COALESCE(attendance.is_late, FALSE) THEN 'LATE'");
      expect(query.sql).toContain("ELSE 'PRESENT'");
    }
  });

  it('reports the ranked elapsed-since-start aggregate without relabeling it as net late minutes', async () => {
    const { repository } = rawHarness(
      [],
      [
        {
          employeeId: EMPLOYEE_ID,
          employeeName: 'Karyawan Terlambat',
          lateCount: 2,
          lateDays: 2,
          totalMinutesAfterScheduledStart: '21.75',
        },
      ],
    );

    const result = await repository.adminDashboard({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      filter: { date: '2026-10-11', page: 1, pageSize: 25 },
      today: '2026-10-11',
    });

    expect(result.lateRanking).toEqual([
      {
        employeeId: EMPLOYEE_ID,
        employeeName: 'Karyawan Terlambat',
        lateCount: 2,
        lateDays: 2,
        totalMinutesAfterScheduledStart: 21.75,
      },
    ]);
  });

  it('does not query Supervisor assignments for Admin and uses the same 30-calendar-day end bound for ranking', async () => {
    const { repository, prisma, queries } = rawHarness();

    await repository.adminDashboard({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      filter: { date: '2026-10-11', page: 1, pageSize: 25 },
      today: '2026-10-11',
    });

    expect(prisma.supervisorStoreAssignment.findMany).not.toHaveBeenCalled();
    const ranking = queries.find((query) =>
      query.sql.includes('"totalMinutesAfterScheduledStart"'),
    );
    expect(ranking?.sql).toContain("status = 'LATE'");
    expect(ranking?.sql).toContain('COUNT(DISTINCT work_date)');
    expect(ranking?.sql).toContain(
      'ORDER BY "lateCount" DESC, "totalMinutesAfterScheduledStart" DESC',
    );
    expect(ranking?.sql).toContain("audit.after_data ->> 'isLate' = 'true'");
    expect(ranking?.sql).toContain("audit.after_data ->> 'minutesAfterScheduledStart'");
    expect(ranking?.values).toContain('2026-09-12');
    expect(ranking?.values).toContain('2026-10-11');
    expect(ranking?.sql).not.toContain('lateMinutes');
  });

  it('AND-scopes employee status, history and requests to the linked account and employee pair', async () => {
    const { repository, prisma, queries } = rawHarness();

    const result = await repository.employeeDashboard({
      userAccountId: ACCOUNT_ID,
      employeeId: EMPLOYEE_ID,
      date: '2026-10-11',
      historyPage: 2,
      historyPageSize: 5,
      requestPage: 3,
      requestPageSize: 7,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('employee.id =');
    expect(queries[0]?.sql).toContain('employee.account_id =');
    expect(/(?:^|[^a-z])e\.id\s*=/.test(queries[0]?.sql ?? '')).toBe(false);
    expect(/(?:^|[^a-z])e\.account_id\s*=/.test(queries[0]?.sql ?? '')).toBe(false);
    expect(queries[0]?.values).toContain(EMPLOYEE_ID);
    expect(prisma.attendance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          employeeId: EMPLOYEE_ID,
          employee: { is: { accountId: ACCOUNT_ID } },
          recordStatus: 'ACTIVE',
        },
        orderBy: [{ workDate: 'desc' }, { serverTime: 'desc' }, { id: 'desc' }],
        skip: 5,
        take: 6,
      }),
    );
    expect(prisma.attendanceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          employeeId: EMPLOYEE_ID,
          employee: { is: { accountId: ACCOUNT_ID } },
        },
        skip: 14,
        take: 8,
      }),
    );
    expect(result).toMatchObject({
      today: [],
      history: { items: [], page: 2, pageSize: 5, hasNextPage: false },
      requests: { items: [], page: 3, pageSize: 7, hasNextPage: false },
    });
  });

  it.each([
    ['from-only', { historyFrom: '2026-10-01' }, { gte: new Date('2026-10-01T00:00:00.000Z') }],
    ['to-only', { historyTo: '2026-10-31' }, { lte: new Date('2026-10-31T00:00:00.000Z') }],
    [
      'inclusive-both-bounds',
      { historyFrom: '2026-10-01', historyTo: '2026-10-31' },
      { gte: new Date('2026-10-01T00:00:00.000Z'), lte: new Date('2026-10-31T00:00:00.000Z') },
    ],
  ])(
    'applies %s to the owner-scoped DATE query before pagination',
    async (_label, bounds, workDate) => {
      const { repository, prisma } = rawHarness();

      await repository.employeeDashboard({
        userAccountId: ACCOUNT_ID,
        employeeId: EMPLOYEE_ID,
        date: '2026-10-11',
        historyPage: 2,
        historyPageSize: 5,
        ...bounds,
        requestPage: 1,
        requestPageSize: 20,
      });

      expect(prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            employeeId: EMPLOYEE_ID,
            employee: { is: { accountId: ACCOUNT_ID } },
            recordStatus: 'ACTIVE',
            workDate,
          },
          orderBy: [{ workDate: 'desc' }, { serverTime: 'desc' }, { id: 'desc' }],
          skip: 5,
          take: 6,
        }),
      );
    },
  );

  it('preserves hasNextPage from the extra row and returns schedule wall times across midnight', async () => {
    const row = (id: string, day: string) => ({
      id,
      workDate: new Date(`${day}T00:00:00.000Z`),
      type: 'CHECK_IN',
      serverTime: new Date(`${day}T22:00:00.000Z`),
      validationStatus: 'VALID',
      store: null,
      shiftAssignment: null,
    });
    const todayItem = {
      employeeId: EMPLOYEE_ID,
      employeeName: 'Karyawan Contoh',
      shiftAssignmentId: '00000000-0000-4000-8000-000000000518',
      shiftId: SHIFT_ID,
      shiftName: 'Shift malam',
      scheduledStartTime: '21:00:00',
      scheduledEndTime: '05:00:00',
      storeId: null,
      storeName: null,
      date: '2026-10-11',
      status: 'NOT_CHECKED_IN',
      checkInAt: null,
      checkOutAt: null,
      minutesAfterScheduledStart: null,
    };
    const { repository, prisma, queries } = rawHarness(
      [],
      [],
      [todayItem],
      [
        row('00000000-0000-4000-8000-000000000521', '2026-10-11'),
        row('00000000-0000-4000-8000-000000000522', '2026-10-10'),
        row('00000000-0000-4000-8000-000000000523', '2026-10-09'),
      ],
    );

    const result = await repository.employeeDashboard({
      userAccountId: ACCOUNT_ID,
      employeeId: EMPLOYEE_ID,
      date: '2026-10-11',
      historyPage: 1,
      historyPageSize: 2,
      requestPage: 1,
      requestPageSize: 20,
    });

    expect(queries[0]?.sql).toContain("to_char(shift.start_time, 'HH24:MI:SS')");
    expect(queries[0]?.sql).toContain("to_char(shift.end_time, 'HH24:MI:SS')");
    expect(result.today[0]).toMatchObject({
      scheduledStartTime: '21:00:00',
      scheduledEndTime: '05:00:00',
    });
    expect(result.history).toMatchObject({ page: 1, pageSize: 2, hasNextPage: true });
    expect(result.history.items).toHaveLength(2);
    expect(prisma.attendance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        orderBy: [{ workDate: 'desc' }, { serverTime: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});
