import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaMonthlyReportRepository } from '../../src/modules/report/prisma-repository.js';
import type { MonthlyReportRepositoryRow } from '../../src/modules/report/index.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000501';
const STORE_A = '00000000-0000-4000-8000-000000000502';
const STORE_B = '00000000-0000-4000-8000-000000000503';
const SHIFT_ASSIGNMENT_A = '00000000-0000-4000-8000-000000000505';
const SHIFT_ASSIGNMENT_B = '00000000-0000-4000-8000-000000000506';

function row(): MonthlyReportRepositoryRow {
  return {
    employeeId: EMPLOYEE_ID,
    employeeName: 'Karyawan A',
    shiftAssignmentId: SHIFT_ASSIGNMENT_A,
    shiftId: '00000000-0000-4000-8000-000000000507',
    shiftName: 'Pagi',
    shiftBreakMinutes: 30,
    storeId: STORE_A,
    storeName: 'Toko A',
    date: '2026-10-01',
    isHoliday: false,
    status: 'PRESENT',
    checkInAt: null,
    checkOutAt: null,
    checkInValidationStatus: 'VALID',
    checkOutValidationStatus: null,
    hasPendingAttendance: false,
    hasLateCheckIn: false,
    pendingValidationStatus: null,
    hasRejectedAttendance: false,
    lateMinutesAfterScheduledStart: null,
    approvedOvertimeMinutes: 0,
  };
}

function requestScope(options: { minutes: number; storeIds: readonly (string | null)[] }) {
  return {
    employeeId: EMPLOYEE_ID,
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2026-10-03T00:00:00.000Z'),
    requestedOvertimeMinutes: options.minutes,
    employee: {
      storeAssignments: options.storeIds
        .filter((storeId): storeId is string => storeId !== null)
        .map((storeId) => ({ storeId })),
      shiftAssignments: options.storeIds.map((storeId, index) => ({
        storeId,
        effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-10-31T00:00:00.000Z'),
        workShift: { workDays: [1, 2, 3, 4, 5, 6, 7] },
        id: index === 0 ? SHIFT_ASSIGNMENT_A : SHIFT_ASSIGNMENT_B,
      })),
    },
  };
}

function harness(requests = [requestScope({ minutes: 60, storeIds: [STORE_A] })]) {
  const queries: Prisma.Sql[] = [];
  const rawRow = row();
  const prisma = {
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => [
        { storeId: STORE_A },
        { storeId: STORE_A },
        { storeId: STORE_B },
      ]),
    },
    attendanceRequest: {
      findMany: vi.fn(async () => requests),
    },
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      queries.push(query);
      return [rawRow];
    }),
  } as unknown as PrismaClient;
  return { repository: new PrismaMonthlyReportRepository(prisma), prisma, queries };
}

describe('PrismaMonthlyReportRepository', () => {
  it('deduplicates Supervisor store assignments from the authenticated account', async () => {
    const { repository, prisma } = harness();
    await expect(repository.listSupervisorStoreIds('supervisor-account')).resolves.toEqual([
      STORE_A,
      STORE_B,
    ]);
    expect(prisma.supervisorStoreAssignment.findMany).toHaveBeenCalledWith({
      where: { supervisorUserAccountId: 'supervisor-account' },
      select: { storeId: true },
    });
  });

  it('ANDs Supervisor scope, requested store and employee filters, and excludes ambiguous overtime', async () => {
    const { repository, prisma, queries } = harness([
      requestScope({ minutes: 60, storeIds: [STORE_A] }),
      requestScope({ minutes: 90, storeIds: [STORE_B] }),
      requestScope({ minutes: 120, storeIds: [STORE_A, STORE_B] }),
      requestScope({ minutes: 180, storeIds: [null] }),
    ]);

    const result = await repository.monthlyReport({
      filter: { month: '2026-10', storeId: STORE_A, employeeId: EMPLOYEE_ID },
      today: '2026-10-11',
      scopedStoreIds: [STORE_A, STORE_B],
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('sa.store_id IN');
    expect(queries[0]?.sql).toContain('sa.store_id =');
    expect(queries[0]?.sql).toContain('employee.id =');
    expect(queries[0]?.values).toContain(STORE_A);
    expect(queries[0]?.values).toContain(STORE_B);
    expect(queries[0]?.values).toContain(EMPLOYEE_ID);
    expect(queries[0]?.values).toContain('2026-10-01');
    expect(queries[0]?.values).toContain('2026-10-31');

    expect(prisma.attendanceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestType: 'OVERTIME',
          status: 'APPROVED',
          approver: { is: { role: 'ADMIN' } },
          employeeId: EMPLOYEE_ID,
        }),
        take: expect.any(Number),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.approvedOvertimeMinutes).toBe(60);
  });

  it('allows an unfiltered Admin to see approved Admin overtime without requiring store attribution', async () => {
    const { repository } = harness([
      requestScope({ minutes: 60, storeIds: [STORE_A, STORE_B] }),
      requestScope({ minutes: 90, storeIds: [null] }),
    ]);

    const result = await repository.monthlyReport({
      filter: { month: '2026-10' },
      today: '2026-10-11',
      scopedStoreIds: null,
    });

    expect(result[0]?.approvedOvertimeMinutes).toBe(150);
  });
});
