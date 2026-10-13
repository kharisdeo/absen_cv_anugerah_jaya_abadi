import { describe, expect, it, vi } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import {
  aggregateMonthlyReport,
  MonthlyReportService,
  MAX_MONTHLY_REPORT_SHIFT_DAYS,
  type MonthlyReportRepository,
  type MonthlyReportRepositoryRow,
} from '../../src/modules/report/index.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000501';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000502';
const STORE_ID = '00000000-0000-4000-8000-000000000503';
const SHIFT_ID = '00000000-0000-4000-8000-000000000504';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000505';
const NOW = new Date('2026-10-11T16:59:59.999Z');

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
    sessionId: 'monthly-report-test-session',
    lastSeenAt: NOW,
  };
}

function reportRow(
  overrides: Partial<MonthlyReportRepositoryRow> = {},
): MonthlyReportRepositoryRow {
  return {
    employeeId: EMPLOYEE_ID,
    employeeName: '=2+2',
    shiftAssignmentId: ASSIGNMENT_ID,
    shiftId: SHIFT_ID,
    shiftName: 'Pagi',
    shiftBreakMinutes: 30,
    storeId: STORE_ID,
    storeName: 'Toko A',
    date: '2026-10-01',
    isHoliday: false,
    status: 'PRESENT',
    checkInAt: new Date('2026-10-01T01:00:00.000Z'),
    checkOutAt: new Date('2026-10-01T10:00:00.000Z'),
    checkInValidationStatus: 'VALID',
    checkOutValidationStatus: 'APPROVED',
    hasPendingAttendance: false,
    hasLateCheckIn: false,
    pendingValidationStatus: null,
    hasRejectedAttendance: false,
    lateMinutesAfterScheduledStart: null,
    approvedOvertimeMinutes: 75,
    ...overrides,
  };
}

function fixtureRows(): readonly MonthlyReportRepositoryRow[] {
  return [
    reportRow(),
    reportRow({
      shiftAssignmentId: '00000000-0000-4000-8000-000000000506',
      shiftId: '00000000-0000-4000-8000-000000000507',
      shiftName: 'Sore',
      date: '2026-10-02',
      status: 'LATE',
      checkInAt: new Date('2026-10-02T01:15:30.000Z'),
      checkOutAt: new Date('2026-10-02T08:45:00.000Z'),
      checkInValidationStatus: 'APPROVED',
      checkOutValidationStatus: 'APPROVED',
      hasLateCheckIn: true,
      lateMinutesAfterScheduledStart: '15.5',
    }),
    reportRow({
      date: '2026-10-03',
      status: 'MISSING_CHECKOUT',
      checkInAt: new Date('2026-10-03T01:20:00.000Z'),
      checkOutAt: null,
      checkInValidationStatus: 'VALID',
      checkOutValidationStatus: null,
      hasLateCheckIn: true,
      lateMinutesAfterScheduledStart: '10.4',
    }),
    reportRow({
      date: '2026-10-04',
      status: 'ABSENT',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
      approvedOvertimeMinutes: 75,
    }),
    reportRow({
      date: '2026-10-05',
      status: 'LEAVE',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
    }),
    reportRow({
      date: '2026-10-06',
      status: 'SICK',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
    }),
    reportRow({
      date: '2026-10-07',
      status: 'ANNUAL_LEAVE',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
    }),
    reportRow({
      date: '2026-10-08',
      status: 'WAITING_VERIFICATION',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
      pendingValidationStatus: 'PENDING_OFFLINE',
    }),
    reportRow({
      date: '2026-10-09',
      status: 'HOLIDAY',
      isHoliday: true,
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
    }),
    reportRow({
      date: '2026-10-12',
      status: 'NOT_STARTED',
      checkInAt: null,
      checkOutAt: null,
      checkInValidationStatus: null,
      checkOutValidationStatus: null,
    }),
  ];
}

function makeRepository(rows = fixtureRows()) {
  const repository: MonthlyReportRepository = {
    listSupervisorStoreIds: vi.fn(async () => [STORE_ID]),
    monthlyReport: vi.fn(async () => rows),
  };
  return repository;
}

describe('aggregateMonthlyReport', () => {
  it('counts a calendar work date once when an employee has multiple shifts that date', () => {
    const report = aggregateMonthlyReport({
      month: '2026-10',
      filter: { month: '2026-10' },
      rows: [
        reportRow(),
        reportRow({
          shiftAssignmentId: '00000000-0000-4000-8000-000000000506',
          shiftId: '00000000-0000-4000-8000-000000000507',
          shiftName: 'Sore',
        }),
      ],
    });

    expect(report.summary[0]?.workDays).toBe(1);
    expect(report.dailyDetails).toHaveLength(2);
  });

  it('uses scheduled shift-days, excludes future/holiday rows, and maps all report metrics consistently', () => {
    const report = aggregateMonthlyReport({
      month: '2026-10',
      filter: { month: '2026-10' },
      rows: fixtureRows(),
    });

    expect(report.summary).toEqual([
      {
        employeeId: EMPLOYEE_ID,
        employeeName: '=2+2',
        workDays: 8,
        present: 1,
        lateCount: 2,
        lateMinutes: 26,
        absent: 1,
        leave: 1,
        sick: 1,
        annualLeave: 1,
        totalWorkMinutes: 930,
        approvedOvertimeMinutes: 75,
      },
    ]);
    expect(report.dailyDetails).toHaveLength(10);
    expect(report.dailyDetails.at(-1)).toMatchObject({ date: '2026-10-12', status: 'NOT_STARTED' });
    expect(report.dailyDetails[7]).toMatchObject({
      status: 'WAITING_VERIFICATION',
      validationStatus: 'PENDING_OFFLINE',
      durationMinutes: null,
    });
    expect(report.dailyDetails[0]?.durationMinutes).toBe(510);
    expect(report.dailyDetails[1]?.durationMinutes).toBe(420);
    expect(report.dailyDetails[2]).toMatchObject({
      status: 'MISSING_CHECKOUT',
      lateMinutesAfterScheduledStart: 10,
      durationMinutes: null,
    });
  });

  it('fails closed when the bounded shift-day result exceeds the configured maximum', () => {
    expect(() =>
      aggregateMonthlyReport({
        month: '2026-10',
        filter: { month: '2026-10' },
        rows: Array.from({ length: MAX_MONTHLY_REPORT_SHIFT_DAYS + 1 }, () => reportRow()),
      }),
    ).toThrowError(expect.objectContaining({ code: 'REPORT_RESULT_TOO_LARGE' }));
  });
});

describe('MonthlyReportService', () => {
  it('normalizes filter, uses the Asia/Jakarta date and asks the repository for Supervisor scope', async () => {
    const repository = makeRepository();
    const audit = { record: vi.fn(async () => ({}) as never) };
    const service = new MonthlyReportService(repository, audit, undefined, () => NOW);

    const report = await service.monthlyReport(principal(UserRole.SUPERVISOR), {
      month: '2026-10',
      storeId: STORE_ID,
    });

    expect(repository.listSupervisorStoreIds).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(repository.monthlyReport).toHaveBeenCalledWith({
      filter: { month: '2026-10', storeId: STORE_ID },
      today: '2026-10-11',
      scopedStoreIds: [STORE_ID],
    });
    expect(report.filters).toEqual({ storeId: STORE_ID, employeeId: null });
  });

  it('rejects Employee and malformed month/UUID filters before querying data', async () => {
    const repository = makeRepository();
    const service = new MonthlyReportService(repository, {
      record: vi.fn(async () => ({}) as never),
    });

    await expect(
      service.monthlyReport(principal(UserRole.EMPLOYEE, EMPLOYEE_ID), { month: '2026-10' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(
      service.monthlyReport(principal(UserRole.ADMIN), { month: '2026-13' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.monthlyReport(principal(UserRole.ADMIN), { month: '2026-10', employeeId: 'bad' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REPORT_INPUT' });
    expect(repository.monthlyReport).not.toHaveBeenCalled();
  });

  it('uses the same aggregated report for XLSX and audits only the export filter/context', async () => {
    const repository = makeRepository();
    const reportInput: unknown[] = [];
    const auditEvents: unknown[] = [];
    const exporter = vi.fn(async (report) => {
      reportInput.push(report);
      return Buffer.from('xlsx-fixture');
    });
    const audit = {
      record: vi.fn(async (event) => {
        auditEvents.push(event);
        return {} as never;
      }),
    };
    const service = new MonthlyReportService(repository, audit, exporter, () => NOW);

    const buffer = await service.exportMonthlyReport(
      principal(UserRole.ADMIN),
      { month: '2026-10', employeeId: EMPLOYEE_ID },
      { clientIp: '192.0.2.10', requestId: 'request-report-export' },
    );

    expect(buffer.toString()).toBe('xlsx-fixture');
    expect(reportInput).toHaveLength(1);
    expect(reportInput[0]).toMatchObject({
      month: '2026-10',
      summary: [{ employeeId: EMPLOYEE_ID, workDays: 8 }],
    });
    expect(
      (reportInput[0] as { dailyDetails: readonly { employeeName: string }[] }).dailyDetails[0],
    ).toMatchObject({ employeeName: '=2+2' });
    expect(auditEvents[0]).toMatchObject({
      action: 'monthly_report.export',
      entityType: 'monthly_report',
      after: { month: '2026-10', employeeId: EMPLOYEE_ID },
      clientIp: '192.0.2.10',
      requestId: 'request-report-export',
    });
    expect(auditEvents[0]).not.toHaveProperty('after.summary');
    expect(auditEvents[0]).not.toHaveProperty('after.dailyDetails');
  });
});
