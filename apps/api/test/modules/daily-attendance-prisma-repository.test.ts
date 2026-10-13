import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaDailyAttendanceRepository } from '../../src/modules/daily-attendance/prisma-repository.js';
import type {
  DailyAttendanceCorrection,
  DailyShiftInstance,
} from '../../src/modules/daily-attendance/index.js';

const employeeId = '00000000-0000-4000-8000-000000000021';
const assignmentId = '00000000-0000-4000-8000-000000000028';
const correctionId = '00000000-0000-4000-8000-000000000031';
const evaluatedAt = new Date('2026-10-11T03:00:00.000Z');
const shift: DailyShiftInstance = {
  employeeId,
  shiftAssignmentId: assignmentId,
  storeId: '00000000-0000-4000-8000-000000000026',
  workDate: '2026-10-09',
  startTime: '09:00:00',
  endTime: '18:00:00',
  workDays: [1, 2, 3, 4, 5],
  holidayDates: [],
  hasAmbiguousStoreHoliday: false,
};

const eligibleGuard = {
  scheduleMissing: false,
  notDue: false,
  nonWorking: false,
  ambiguousStoreHoliday: false,
  attendanceExists: false,
  requestExists: false,
  correctionExists: false,
  pendingAttemptExists: false,
  disruptionExists: false,
  closed: false,
};

function setup(
  options: {
    guard?: Partial<typeof eligibleGuard>;
    inserted?: boolean;
    correction?: Partial<{
      scheduleMissing: boolean;
      approvedCorrection: boolean;
      closed: boolean;
      checkInServerTime: Date | null;
      startTime: string | null;
      endTime: string | null;
      lateToleranceMinutes: number | null;
    }>;
  } = {},
) {
  const queries: Prisma.Sql[] = [];
  const transaction = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      queries.push(query);
      if (query.sql.includes('FROM employees')) return [{ id: employeeId }];
      if (query.sql.includes('AS "approvedCorrection"')) {
        return [
          {
            scheduleMissing: false,
            approvedCorrection: true,
            closed: false,
            checkInServerTime: new Date('2026-10-09T02:06:00.000Z'),
            startTime: '09:00:00',
            endTime: '18:00:00',
            lateToleranceMinutes: 5,
            ...options.correction,
          },
        ];
      }
      if (query.sql.includes('AS "scheduleMissing"')) {
        return [{ ...eligibleGuard, ...options.guard }];
      }
      if (query.sql.includes('INSERT INTO daily_attendance_statuses')) {
        return options.inserted === false ? [] : [{ id: 'daily-status-id' }];
      }
      return [];
    }),
  };
  const prisma = {
    $queryRaw: transaction.$queryRaw,
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  };
  return {
    repository: new PrismaDailyAttendanceRepository(prisma as never),
    transaction,
    queries,
  };
}

describe('PrismaDailyAttendanceRepository', () => {
  it('rechecks shift facts under the shared employee lock and scopes RECEIVED attempts to the shift window', async () => {
    const { repository, transaction, queries } = setup();

    expect(await repository.markAbsentIfEligible({ shift, evaluatedAt })).toBe('created');
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain('FOR UPDATE');
    expect(queries[1]?.sql).toContain("AT TIME ZONE 'Asia/Jakarta'");
    expect(queries[1]?.sql).toContain("ends_at + interval '2 hours'");
    expect(queries[1]?.sql).toContain("attempt.processing_status = 'RECEIVED'");
    expect(queries[1]?.sql).toContain('attempt.received_at >= shift_window.starts_at');
    expect(queries[1]?.sql).toContain(
      "attempt.received_at <= shift_window.ends_at + interval '2 hours'",
    );
    expect(queries[1]?.sql).toContain('attempt.received_at <=');
    expect(queries[1]?.sql).toContain('attempt.store_id = shift_window.store_id');
    expect(queries[1]?.sql).toContain("request.status IN ('PENDING', 'APPROVED')");
    expect(queries[1]?.sql).toContain("correction.status = 'PENDING'");
    expect(queries[1]?.sql).toContain('disruption.starts_at < shift_window.ends_at');
    expect(queries[1]?.sql).toContain('disruption.store_id IS NULL');
    expect(queries[1]?.sql).toContain('disruption.store_id = shift_window.store_id');
    expect(queries[1]?.sql).toContain('employee_store.employee_id = shift_window.employee_id');
    expect(queries[1]?.sql).toContain('employee_store.store_id = disruption.store_id');
    expect(queries[1]?.sql).toContain("recap.status = 'CLOSED'");
    expect(queries[2]?.sql).toContain(
      'ON CONFLICT (employee_id, shift_assignment_id, work_date) DO NOTHING',
    );
    expect(
      queries.every(
        (query) =>
          !/UPDATE\s+(attendances|attendance_attempts)|DELETE\s+FROM\s+(attendances|attendance_attempts)/i.test(
            query.sql,
          ),
      ),
    ).toBe(true);
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.$queryRaw.mock.invocationCallOrder[1]!,
    );
  });

  it('keeps disruption overlap half-open so exact boundary contact does not block ABSENT', async () => {
    const { repository, queries } = setup({ guard: { disruptionExists: false } });

    expect(await repository.markAbsentIfEligible({ shift, evaluatedAt })).toBe('created');
    const guardQuery = queries.find((query) => query.sql.includes('AS "disruptionExists"'));
    expect(guardQuery?.sql).toContain('disruption.starts_at < shift_window.ends_at');
    expect(guardQuery?.sql).toContain('disruption.ends_at > shift_window.starts_at');
    expect(guardQuery?.sql).not.toMatch(/disruption\.(?:starts_at|ends_at)\s*<=/);
    expect(queries.at(-1)?.sql).toContain("'ABSENT'::daily_attendance_status");
  });

  it('does not let a later-day attempt block yesterday because its receipt is after yesterday cutoff', async () => {
    const laterEvaluation = new Date('2026-10-13T03:00:00.000Z');
    const { repository, queries } = setup();

    expect(await repository.markAbsentIfEligible({ shift, evaluatedAt: laterEvaluation })).toBe(
      'created',
    );
    const guardQuery = queries[1]!;
    expect(guardQuery.sql).toContain(
      "attempt.received_at <= shift_window.ends_at + interval '2 hours'",
    );
    expect(guardQuery.sql).toContain('attempt.received_at <=');
    expect(guardQuery.values).toContain(laterEvaluation);
  });

  it.each([
    ['attendance snapshot', { attendanceExists: true }],
    ['pending request', { requestExists: true }],
    ['pending correction', { correctionExists: true }],
    ['visible pending attempt', { pendingAttemptExists: true }],
    ['overlapping disruption', { disruptionExists: true }],
  ])('does not insert ABSENT when a transactional guard sees %s', async (_name, guard) => {
    const { repository, queries } = setup({ guard });

    expect(await repository.markAbsentIfEligible({ shift, evaluatedAt })).toBe('blocked');
    expect(
      queries.some((query) => query.sql.includes('INSERT INTO daily_attendance_statuses')),
    ).toBe(false);
  });

  it.each([
    ['closed month', { closed: true }, 'closed'],
    ['nonworking date', { nonWorking: true }, 'non_working'],
    ['ambiguous local holiday', { ambiguousStoreHoliday: true }, 'ambiguous_holiday'],
    ['cutoff not reached', { notDue: true }, 'not_due'],
  ] as const)(
    'rejects stale job candidates when %s changed before the transaction',
    async (_name, guard, expected) => {
      const { repository, queries } = setup({ guard });

      expect(await repository.markAbsentIfEligible({ shift, evaluatedAt })).toBe(expected);
      expect(
        queries.some((query) => query.sql.includes('INSERT INTO daily_attendance_statuses')),
      ).toBe(false);
    },
  );

  it('uses a unique-key no-op on retry instead of duplicating or overwriting a daily row', async () => {
    const { repository, queries } = setup({ inserted: false });

    expect(await repository.markAbsentIfEligible({ shift, evaluatedAt })).toBe('exists');
    expect(queries.at(-1)?.sql).toContain('DO NOTHING');
  });

  it('does not apply a correction after closing and derives its target from persisted approved CHECK_IN data', async () => {
    const closed = setup({ correction: { closed: true } });
    const correction: DailyAttendanceCorrection = {
      correctionId,
      employeeId,
      shiftAssignmentId: assignmentId,
      workDate: '2026-10-09',
    };

    expect(await closed.repository.applyApprovedCorrection(correction)).toBe(false);
    expect(
      closed.queries.some((query) => query.sql.includes('INSERT INTO daily_attendance_statuses')),
    ).toBe(false);

    const approved = setup();
    expect(await approved.repository.applyApprovedCorrection(correction)).toBe(true);
    const validation = approved.queries.find((query) =>
      query.sql.includes('FROM attendance_corrections AS correction'),
    );
    const write = approved.queries.find((query) =>
      query.sql.includes('INSERT INTO daily_attendance_statuses'),
    );
    expect(validation?.sql).toContain("correction.status = 'APPROVED'");
    expect(validation?.sql).toContain("correction.proposed_type = 'CHECK_IN'");
    expect(validation?.sql).toContain('correction.proposed_server_time IS NOT NULL');
    expect(write?.values).toContain('LATE');
    expect(write?.values).toContain(correctionId);
  });

  it('classifies holidays for a store-bound shift and leaves local holidays ambiguous for a global shift', async () => {
    const rows = [
      {
        employeeId,
        shiftAssignmentId: assignmentId,
        storeId: null,
        workDate: '2026-10-09',
        startTime: '09:00:00',
        endTime: '18:00:00',
        workDays: [1, 2, 3, 4, 5],
        holidayDates: [],
        hasAmbiguousStoreHoliday: true,
      },
    ];
    const query = vi.fn(async (sql: Prisma.Sql) => {
      void sql;
      return rows;
    });
    const repository = new PrismaDailyAttendanceRepository({ $queryRaw: query } as never);

    expect(await repository.listShiftInstances(['2026-10-09'])).toEqual(rows);
    expect(query.mock.calls[0]?.[0].sql).toContain('holiday.store_id = sa.store_id');
    expect(query.mock.calls[0]?.[0].sql).toContain('AS "hasAmbiguousStoreHoliday"');
    expect(query.mock.calls[0]?.[0].sql).toContain('assigned_store.is_active = TRUE');
  });
});
