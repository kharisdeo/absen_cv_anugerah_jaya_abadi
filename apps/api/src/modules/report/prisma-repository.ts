import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { RequestStatus, RequestType, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import { deriveUniqueScheduledStore } from '../attendance-requests/prisma-repository.js';
import { statusRowsCte } from '../dashboard/prisma-repository.js';
import { MAX_MONTHLY_REPORT_SHIFT_DAYS } from './index.js';
import type {
  MonthlyReportFilter,
  MonthlyReportRepository,
  MonthlyReportRepositoryRow,
} from './index.js';

const overtimeRequestScopeSelect = {
  employeeId: true,
  startDate: true,
  endDate: true,
  requestedOvertimeMinutes: true,
  employee: {
    select: {
      storeAssignments: { select: { storeId: true } },
      shiftAssignments: {
        select: {
          storeId: true,
          effectiveFrom: true,
          effectiveTo: true,
          workShift: { select: { workDays: true } },
        },
      },
    },
  },
} as const;

type OvertimeRequestScopeRow = Prisma.AttendanceRequestGetPayload<{
  select: typeof overtimeRequestScopeSelect;
}>;

function monthBounds(month: string): Readonly<{ from: string; to: string }> {
  const [year, monthNumber] = month.split('-').map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return { from, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function requestHasAllowedStore(
  request: OvertimeRequestScopeRow,
  allowedStoreIds: readonly string[] | null,
): boolean {
  // Admin with no store filter may see the employee's full approved overtime total.
  // A store/Supervisor report requires a single, server-derived store for the entire request.
  if (allowedStoreIds === null) return true;
  const storeId = deriveUniqueScheduledStore(
    request.employee.shiftAssignments,
    request.employee.storeAssignments.map(({ storeId }) => storeId),
    request.startDate,
    request.endDate,
  );
  return storeId !== null && allowedStoreIds.includes(storeId);
}

function approvedOvertimeScope(input: {
  filter: MonthlyReportFilter;
  scopedStoreIds: readonly string[] | null;
}): readonly string[] | null {
  if (input.scopedStoreIds === null) {
    return input.filter.storeId === undefined ? null : [input.filter.storeId];
  }
  return input.scopedStoreIds.filter(
    (storeId) => input.filter.storeId === undefined || input.filter.storeId === storeId,
  );
}

export class PrismaMonthlyReportRepository implements MonthlyReportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listSupervisorStoreIds(userAccountId: string): Promise<readonly string[]> {
    const assignments = await this.prisma.supervisorStoreAssignment.findMany({
      where: { supervisorUserAccountId: userAccountId },
      select: { storeId: true },
    });
    return [...new Set(assignments.map(({ storeId }) => storeId))];
  }

  async monthlyReport(
    input: Readonly<{
      filter: MonthlyReportFilter;
      today: string;
      scopedStoreIds: readonly string[] | null;
    }>,
  ): Promise<readonly MonthlyReportRepositoryRow[]> {
    const bounds = monthBounds(input.filter.month);
    const cte = statusRowsCte({
      from: bounds.from,
      to: bounds.to,
      today: input.today,
      scopedStoreIds: input.scopedStoreIds,
      ignoreCorrections: true,
      ...(input.filter.storeId === undefined ? {} : { storeId: input.filter.storeId }),
      ...(input.filter.employeeId === undefined ? {} : { employeeId: input.filter.employeeId }),
    });
    const allowedOvertimeStores = approvedOvertimeScope(input);

    const [rows, overtimeRequests] = await Promise.all([
      this.prisma.$queryRaw<readonly MonthlyReportRepositoryRow[]>(Prisma.sql`
        ${cte}
        SELECT
          status_rows.employee_id AS "employeeId",
          status_rows.employee_name AS "employeeName",
          status_rows.shift_assignment_id AS "shiftAssignmentId",
          status_rows.shift_id AS "shiftId",
          status_rows.shift_name AS "shiftName",
          status_rows.shift_break_minutes AS "shiftBreakMinutes",
          status_rows.store_id AS "storeId",
          status_rows.store_name AS "storeName",
          status_rows.work_date::text AS date,
          status_rows.is_holiday AS "isHoliday",
          status_rows.status::text AS status,
          status_rows.check_in_at AS "checkInAt",
          status_rows.check_out_at AS "checkOutAt",
          status_rows.check_in_validation_status AS "checkInValidationStatus",
          status_rows.check_out_validation_status AS "checkOutValidationStatus",
          COALESCE(status_rows.has_pending, FALSE) AS "hasPendingAttendance",
          COALESCE(status_rows.has_late_check_in, FALSE) AS "hasLateCheckIn",
          CASE
            WHEN COALESCE(status_rows.has_pending_verification, FALSE) THEN 'PENDING_VERIFICATION'
            WHEN COALESCE(status_rows.has_pending_offline, FALSE) THEN 'PENDING_OFFLINE'
            ELSE NULL
          END AS "pendingValidationStatus",
          COALESCE(status_rows.has_rejected, FALSE) AS "hasRejectedAttendance",
          status_rows.late_minutes AS "lateMinutesAfterScheduledStart",
          0::integer AS "approvedOvertimeMinutes"
        FROM status_rows
        ORDER BY status_rows.work_date, status_rows.employee_name,
          status_rows.shift_name, status_rows.shift_assignment_id
        LIMIT ${MAX_MONTHLY_REPORT_SHIFT_DAYS + 1}
      `),
      this.prisma.attendanceRequest.findMany({
        where: {
          requestType: RequestType.OVERTIME,
          status: RequestStatus.APPROVED,
          approver: { is: { role: UserRole.ADMIN } },
          startDate: { gte: dateOnly(bounds.from), lte: dateOnly(bounds.to) },
          ...(input.filter.employeeId === undefined ? {} : { employeeId: input.filter.employeeId }),
        },
        select: overtimeRequestScopeSelect,
        take: MAX_MONTHLY_REPORT_SHIFT_DAYS + 1,
      }),
    ]);

    if (overtimeRequests.length > MAX_MONTHLY_REPORT_SHIFT_DAYS) {
      throw new AppError(
        413,
        'REPORT_RESULT_TOO_LARGE',
        'Rekap lembur melebihi batas pemrosesan. Tambahkan filter karyawan atau periode lain.',
      );
    }

    const overtimeByEmployee = new Map<string, number>();
    for (const request of overtimeRequests) {
      if (!requestHasAllowedStore(request, allowedOvertimeStores)) continue;
      const minutes = Math.max(0, request.requestedOvertimeMinutes ?? 0);
      overtimeByEmployee.set(
        request.employeeId,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          (overtimeByEmployee.get(request.employeeId) ?? 0) + minutes,
        ),
      );
    }

    return rows.map((row) => ({
      ...row,
      approvedOvertimeMinutes: overtimeByEmployee.get(row.employeeId) ?? 0,
    }));
  }
}
