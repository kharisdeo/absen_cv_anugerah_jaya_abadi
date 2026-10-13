import { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import {
  BUSINESS_TIME_ZONE,
  assertBusinessDate,
  getBusinessDateAndWeekday,
} from '../time/index.js';
import { buildMonthlyReportWorkbook } from './xlsx.js';

// Covers the 200-employee / 20-store NFR fixture even at two shifts every day
// (12,400 rows) while keeping one response/workbook finite.
export const MAX_MONTHLY_REPORT_SHIFT_DAYS = 25_000;

export type MonthlyReportFilter = Readonly<{
  month: string;
  storeId?: string;
  employeeId?: string;
}>;

export type MonthlyReportStatus =
  | 'PRESENT'
  | 'LATE'
  | 'NOT_CHECKED_IN'
  | 'ABSENT'
  | 'LEAVE'
  | 'SICK'
  | 'ANNUAL_LEAVE'
  | 'WAITING_VERIFICATION'
  | 'REQUEST_PENDING'
  | 'HOLIDAY'
  | 'EARLY_LEAVE'
  | 'MISSING_CHECKOUT'
  | 'UNATTRIBUTED_ATTENDANCE'
  | 'NOT_STARTED';

export type AttendanceValidationStatus =
  'VALID' | 'APPROVED' | 'PENDING_VERIFICATION' | 'PENDING_OFFLINE' | 'REJECTED';

export type DailyReportDetail = Readonly<{
  employeeId: string;
  employeeName: string;
  date: string;
  store: Readonly<{ id: string; name: string }> | null;
  shift: Readonly<{ assignmentId: string; id: string; name: string }>;
  checkInAt: string | null;
  checkOutAt: string | null;
  durationMinutes: number | null;
  lateMinutesAfterScheduledStart: number | null;
  status: MonthlyReportStatus;
  checkInValidationStatus: AttendanceValidationStatus | null;
  checkOutValidationStatus: AttendanceValidationStatus | null;
  validationStatus: AttendanceValidationStatus | 'MIXED' | null;
}>;

export type MonthlyReportSummary = Readonly<{
  employeeId: string;
  employeeName: string;
  workDays: number;
  present: number;
  lateCount: number;
  lateMinutes: number;
  absent: number;
  leave: number;
  sick: number;
  annualLeave: number;
  totalWorkMinutes: number;
  approvedOvertimeMinutes: number;
}>;

export type MonthlyReportData = Readonly<{
  month: string;
  filters: Readonly<{ storeId: string | null; employeeId: string | null }>;
  definitions: Readonly<{
    workDays: 'scheduled_employee_work_dates_excluding_holidays';
    workMinutes: 'valid_approved_pair_rounded_to_nearest_minute_less_shift_break';
    lateMinutes: 'rounded_minutes_after_scheduled_start_including_tolerance';
    overtime: 'approved_admin_requests_unique_store_when_store_scoped';
  }>;
  summary: readonly MonthlyReportSummary[];
  dailyDetails: readonly DailyReportDetail[];
}>;

export type MonthlyReportRepositoryRow = Readonly<{
  employeeId: string;
  employeeName: string;
  shiftAssignmentId: string;
  shiftId: string;
  shiftName: string;
  shiftBreakMinutes: number;
  storeId: string | null;
  storeName: string | null;
  date: string;
  isHoliday: boolean;
  status: MonthlyReportStatus;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  checkInValidationStatus: AttendanceValidationStatus | null;
  checkOutValidationStatus: AttendanceValidationStatus | null;
  hasPendingAttendance: boolean;
  hasLateCheckIn: boolean;
  pendingValidationStatus: 'PENDING_VERIFICATION' | 'PENDING_OFFLINE' | null;
  hasRejectedAttendance: boolean;
  lateMinutesAfterScheduledStart: number | string | null;
  approvedOvertimeMinutes: number | string;
}>;

export interface MonthlyReportRepository {
  listSupervisorStoreIds(userAccountId: string): Promise<readonly string[]>;
  monthlyReport(
    input: Readonly<{
      filter: MonthlyReportFilter;
      today: string;
      scopedStoreIds: readonly string[] | null;
    }>,
  ): Promise<readonly MonthlyReportRepositoryRow[]>;
}

export type MonthlyReportRequestContext = Readonly<{
  clientIp?: string;
  requestId: string;
}>;

export type MonthlyReportExporter = (report: MonthlyReportData) => Promise<Buffer>;

const REPORT_DEFINITIONS = Object.freeze({
  workDays: 'scheduled_employee_work_dates_excluding_holidays',
  workMinutes: 'valid_approved_pair_rounded_to_nearest_minute_less_shift_break',
  lateMinutes: 'rounded_minutes_after_scheduled_start_including_tolerance',
  overtime: 'approved_admin_requests_unique_store_when_store_scoped',
} as const);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function invalidInput(message: string): AppError {
  return new AppError(400, 'INVALID_REPORT_INPUT', message);
}

function normalizeFilter(input: MonthlyReportFilter): MonthlyReportFilter {
  const match = MONTH_PATTERN.exec(input.month);
  if (!match) throw invalidInput('Bulan harus menggunakan format YYYY-MM.');
  try {
    assertBusinessDate(`${input.month}-01`);
  } catch {
    throw invalidInput('Bulan harus berupa bulan kalender yang valid.');
  }
  if (input.storeId !== undefined && !UUID_PATTERN.test(input.storeId)) {
    throw invalidInput('storeId tidak valid.');
  }
  if (input.employeeId !== undefined && !UUID_PATTERN.test(input.employeeId)) {
    throw invalidInput('employeeId tidak valid.');
  }
  return input;
}

function safeNonNegativeInteger(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed));
}

function roundedElapsedMinutes(checkInAt: Date, checkOutAt: Date, breakMinutes: number): number {
  const elapsedMs = checkOutAt.getTime() - checkInAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const elapsedMinutes = Math.floor(elapsedMs / 60_000 + 0.5);
  return Math.max(0, elapsedMinutes - breakMinutes);
}

function validationStatusOf(
  row: MonthlyReportRepositoryRow,
): AttendanceValidationStatus | 'MIXED' | null {
  if (row.pendingValidationStatus) return row.pendingValidationStatus;
  const statuses = [row.checkInValidationStatus, row.checkOutValidationStatus].filter(
    (status): status is AttendanceValidationStatus => status !== null,
  );
  const distinct = [...new Set(statuses)];
  if (distinct.length > 1) return 'MIXED';
  if (distinct.length === 1) return distinct[0]!;
  return row.hasRejectedAttendance ? 'REJECTED' : null;
}

function datePart(date: Date | null): string | null {
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * The one report aggregator used by both JSON and XLSX. Summary workDays counts unique
 * employee work dates; dailyDetails remains one row per scheduled employee shift-day.
 */
export function aggregateMonthlyReport(
  input: Readonly<{
    month: string;
    filter: MonthlyReportFilter;
    rows: readonly MonthlyReportRepositoryRow[];
  }>,
): MonthlyReportData {
  if (input.rows.length > MAX_MONTHLY_REPORT_SHIFT_DAYS) {
    throw new AppError(
      413,
      'REPORT_RESULT_TOO_LARGE',
      `Rekap melebihi batas ${MAX_MONTHLY_REPORT_SHIFT_DAYS} shift-hari. Tambahkan filter toko atau karyawan.`,
    );
  }

  const summaries = new Map<
    string,
    {
      employeeId: string;
      employeeName: string;
      workDates: Set<string>;
      present: number;
      lateCount: number;
      lateMinutes: number;
      absent: number;
      leave: number;
      sick: number;
      annualLeave: number;
      totalWorkMinutes: number;
      approvedOvertimeMinutes: number;
    }
  >();

  const dailyDetails: DailyReportDetail[] = [];
  for (const row of input.rows) {
    let summary = summaries.get(row.employeeId);
    if (!summary) {
      summary = {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        workDates: new Set<string>(),
        present: 0,
        lateCount: 0,
        lateMinutes: 0,
        absent: 0,
        leave: 0,
        sick: 0,
        annualLeave: 0,
        totalWorkMinutes: 0,
        approvedOvertimeMinutes: 0,
      };
      summaries.set(row.employeeId, summary);
    }

    if (!row.isHoliday && row.status !== 'NOT_STARTED') summary.workDates.add(row.date);
    if (row.status === 'PRESENT') summary.present += 1;
    if (row.hasLateCheckIn) {
      summary.lateCount += 1;
      summary.lateMinutes += safeNonNegativeInteger(row.lateMinutesAfterScheduledStart);
    }
    if (row.status === 'ABSENT') summary.absent += 1;
    if (row.status === 'LEAVE') summary.leave += 1;
    if (row.status === 'SICK') summary.sick += 1;
    if (row.status === 'ANNUAL_LEAVE') summary.annualLeave += 1;

    const durationMinutes =
      row.checkInAt && row.checkOutAt
        ? roundedElapsedMinutes(row.checkInAt, row.checkOutAt, row.shiftBreakMinutes)
        : null;
    if (durationMinutes !== null) summary.totalWorkMinutes += durationMinutes;
    summary.approvedOvertimeMinutes = Math.max(
      summary.approvedOvertimeMinutes,
      safeNonNegativeInteger(row.approvedOvertimeMinutes),
    );

    dailyDetails.push({
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      date: row.date,
      store: row.storeId && row.storeName ? { id: row.storeId, name: row.storeName } : null,
      shift: {
        assignmentId: row.shiftAssignmentId,
        id: row.shiftId,
        name: row.shiftName,
      },
      checkInAt: datePart(row.checkInAt),
      checkOutAt: datePart(row.checkOutAt),
      durationMinutes,
      lateMinutesAfterScheduledStart: row.hasLateCheckIn
        ? safeNonNegativeInteger(row.lateMinutesAfterScheduledStart)
        : null,
      status: row.status,
      checkInValidationStatus: row.checkInValidationStatus,
      checkOutValidationStatus: row.checkOutValidationStatus,
      validationStatus: validationStatusOf(row),
    });
  }

  const summaryRows: MonthlyReportSummary[] = [...summaries.values()]
    .map(({ workDates, ...row }) => ({ ...row, workDays: workDates.size }))
    .sort(
      (a, b) =>
        a.employeeName.localeCompare(b.employeeName, 'id') ||
        a.employeeId.localeCompare(b.employeeId),
    );

  return {
    month: input.month,
    filters: {
      storeId: input.filter.storeId ?? null,
      employeeId: input.filter.employeeId ?? null,
    },
    definitions: REPORT_DEFINITIONS,
    summary: summaryRows,
    dailyDetails,
  };
}

export class MonthlyReportService {
  constructor(
    private readonly repository: MonthlyReportRepository,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly exporter: MonthlyReportExporter = buildMonthlyReportWorkbook,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = BUSINESS_TIME_ZONE,
  ) {}

  async monthlyReport(
    principal: AuthPrincipal,
    filter: MonthlyReportFilter,
  ): Promise<MonthlyReportData> {
    this.assertAllowedRole(principal);
    const normalized = normalizeFilter(filter);
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new AppError(503, 'INTERNAL_SERVER_ERROR', 'Waktu server tidak tersedia.');
    }
    const today = getBusinessDateAndWeekday(now, this.timeZone).businessDate;
    let scopedStoreIds: readonly string[] | null = null;
    if (principal.role === UserRole.SUPERVISOR) {
      scopedStoreIds = await this.repository.listSupervisorStoreIds(principal.userAccountId);
    }
    const rows = await this.repository.monthlyReport({
      filter: normalized,
      today,
      scopedStoreIds,
    });
    return aggregateMonthlyReport({ month: normalized.month, filter: normalized, rows });
  }

  async exportMonthlyReport(
    principal: AuthPrincipal,
    filter: MonthlyReportFilter,
    context: MonthlyReportRequestContext,
  ): Promise<Buffer> {
    this.assertAllowedRole(principal);
    const report = await this.monthlyReport(principal, filter);
    const buffer = await this.exporter(report);
    const actor: AuditActor = {
      userAccountId: principal.userAccountId,
      role: principal.role,
    };
    await this.audit.record({
      actor,
      action: 'monthly_report.export',
      entityType: 'monthly_report',
      after: {
        month: report.month,
        ...(report.filters.storeId ? { storeId: report.filters.storeId } : {}),
        ...(report.filters.employeeId ? { employeeId: report.filters.employeeId } : {}),
      },
      ...context,
    });
    return buffer;
  }

  private assertAllowedRole(principal: AuthPrincipal): asserts principal is AuthPrincipal & {
    role: typeof UserRole.ADMIN | typeof UserRole.SUPERVISOR;
  } {
    if (principal.role !== UserRole.ADMIN && principal.role !== UserRole.SUPERVISOR) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Rekap bulanan hanya tersedia untuk Admin dan Supervisor.',
      );
    }
  }
}
