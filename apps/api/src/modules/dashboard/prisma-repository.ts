import { Prisma, UserRole } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  DashboardActor,
  DashboardData,
  DashboardFilter,
  DashboardLateRankingItem,
  DashboardShiftItem,
  DashboardStatus,
  DashboardSummary,
  DashboardTrendItem,
  EmployeeHistoryItem,
  EmployeeRequestStatusItem,
} from './index.js';

type ScalarCount = number | bigint | string | null;

type SummaryRow = Readonly<{
  scheduledShifts: ScalarCount;
  present: ScalarCount;
  late: ScalarCount;
  notCheckedIn: ScalarCount;
  absent: ScalarCount;
  leave: ScalarCount;
  sick: ScalarCount;
  annualLeave: ScalarCount;
  waitingVerification: ScalarCount;
  pendingRequests: ScalarCount;
}>;

type ShiftRow = Readonly<{
  employeeId: string;
  employeeName: string;
  shiftAssignmentId: string;
  shiftId: string;
  shiftName: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  storeId: string | null;
  storeName: string | null;
  date: string;
  status: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  minutesAfterScheduledStart: number | string | null;
}>;

type TrendRow = SummaryRow & Readonly<{ date: string }>;
type RankingRow = Readonly<{
  employeeId: string;
  employeeName: string;
  lateCount: ScalarCount;
  lateDays: ScalarCount;
  totalMinutesAfterScheduledStart: number | string | null;
}>;

type CteFilter = DashboardFilter &
  Readonly<{
    from: string;
    to: string;
    today: string;
    scopedStoreIds: readonly string[] | null;
    employee?: Readonly<{ employeeId: string; userAccountId: string }>;
    employeeId?: string;
    ignoreCorrections?: boolean;
  }>;

function asCount(value: ScalarCount): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function asDecimal(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function summary(row: SummaryRow | undefined): DashboardSummary {
  return {
    scheduledShifts: asCount(row?.scheduledShifts ?? 0),
    present: asCount(row?.present ?? 0),
    late: asCount(row?.late ?? 0),
    notCheckedIn: asCount(row?.notCheckedIn ?? 0),
    absent: asCount(row?.absent ?? 0),
    leave: asCount(row?.leave ?? 0),
    sick: asCount(row?.sick ?? 0),
    annualLeave: asCount(row?.annualLeave ?? 0),
    waitingVerification: asCount(row?.waitingVerification ?? 0),
    pendingRequests: asCount(row?.pendingRequests ?? 0),
  };
}

function toShiftItem(row: ShiftRow): DashboardShiftItem {
  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    shiftAssignmentId: row.shiftAssignmentId,
    shiftId: row.shiftId,
    shiftName: row.shiftName,
    scheduledStartTime: row.scheduledStartTime,
    scheduledEndTime: row.scheduledEndTime,
    store: row.storeId && row.storeName ? { id: row.storeId, name: row.storeName } : null,
    date: row.date,
    status: row.status as DashboardStatus,
    checkInAt: row.checkInAt?.toISOString() ?? null,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    minutesAfterScheduledStart: asDecimal(row.minutesAfterScheduledStart),
  };
}

function subtractCalendarDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}

/** Prisma represents PostgreSQL DATE values as UTC-midnight Date objects; preserve date parts only. */
function prismaDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function statusRowsCte(input: CteFilter): Prisma.Sql {
  const filters: Prisma.Sql[] = [];
  if (input.scopedStoreIds !== null) {
    filters.push(
      input.scopedStoreIds.length
        ? Prisma.sql`sa.store_id IN (${Prisma.join(input.scopedStoreIds.map((id) => Prisma.sql`${id}::uuid`))})`
        : Prisma.sql`FALSE`,
    );
  }
  if (input.storeId !== undefined) filters.push(Prisma.sql`sa.store_id = ${input.storeId}::uuid`);
  if (input.shiftId !== undefined)
    filters.push(Prisma.sql`sa.work_shift_id = ${input.shiftId}::uuid`);
  if (input.employee !== undefined) {
    filters.push(
      Prisma.sql`e.id = ${input.employee.employeeId}::uuid AND e.account_id = ${input.employee.userAccountId}::uuid`,
    );
  }
  if (input.employeeId !== undefined) {
    filters.push(Prisma.sql`employee.id = ${input.employeeId}::uuid`);
  }
  const filterSql = filters.length ? Prisma.join(filters, ' AND ') : Prisma.sql`TRUE`;

  return Prisma.sql`
    WITH work_dates AS (
      SELECT value::date AS work_date
      FROM generate_series(${input.from}::date, ${input.to}::date, interval '1 day') AS value
    ), schedule AS (
      SELECT
        dates.work_date,
        sa.id AS shift_assignment_id,
        sa.employee_id,
        employee.full_name AS employee_name,
        sa.store_id,
        store.name AS store_name,
        sa.work_shift_id AS shift_id,
        shift.name AS shift_name,
        shift.break_minutes AS shift_break_minutes,
        to_char(shift.start_time, 'HH24:MI:SS') AS scheduled_start_time,
        to_char(shift.end_time, 'HH24:MI:SS') AS scheduled_end_time,
        EXISTS (
          SELECT 1 FROM holidays national_holiday
          WHERE national_holiday.holiday_date = dates.work_date
            AND national_holiday.store_id IS NULL
        ) OR EXISTS (
          SELECT 1 FROM holidays store_holiday
          WHERE store_holiday.holiday_date = dates.work_date
            AND store_holiday.store_id = sa.store_id
        ) AS is_holiday
      FROM work_dates dates
      INNER JOIN shift_assignments sa
        ON sa.effective_from <= dates.work_date
       AND (sa.effective_to IS NULL OR sa.effective_to >= dates.work_date)
      INNER JOIN work_shifts shift ON shift.id = sa.work_shift_id
      INNER JOIN employees employee ON employee.id = sa.employee_id
      LEFT JOIN stores store ON store.id = sa.store_id
      WHERE EXTRACT(ISODOW FROM dates.work_date)::integer = ANY(shift.work_days)
        AND (employee.status = 'ACTIVE' OR dates.work_date < ${input.today}::date)
        AND (shift.is_active = TRUE OR dates.work_date < ${input.today}::date)
        AND (sa.store_id IS NULL OR EXISTS (
          SELECT 1 FROM employee_stores employee_store
          WHERE employee_store.employee_id = sa.employee_id
            AND employee_store.store_id = sa.store_id
        ))
        AND NOT (
          sa.store_id IS NULL AND EXISTS (
            SELECT 1
            FROM holidays local_holiday
            INNER JOIN employee_stores employee_store
              ON employee_store.employee_id = sa.employee_id
             AND employee_store.store_id = local_holiday.store_id
            INNER JOIN stores assigned_store
              ON assigned_store.id = employee_store.store_id
             AND assigned_store.is_active = TRUE
            WHERE local_holiday.holiday_date = dates.work_date
              AND local_holiday.store_id IS NOT NULL
          )
        )
        AND (${filterSql})
    ), attendance_timing AS (
      SELECT
        attendance.id,
        attendance.employee_id,
        attendance.shift_assignment_id,
        attendance.work_date,
        attendance.type,
        attendance.server_time,
        attendance.validation_status,
        attendance.record_status,
        audit.after_data ->> 'isLate' = 'true' AS was_late,
        CASE
          WHEN (audit.after_data ->> 'minutesAfterScheduledStart') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN (audit.after_data ->> 'minutesAfterScheduledStart')::numeric
          ELSE NULL
        END AS minutes_after_scheduled_start
      FROM attendances attendance
      LEFT JOIN LATERAL (
        SELECT log.after_data
        FROM audit_logs log
        WHERE log.entity_type = 'attendance'
          AND log.entity_id = attendance.id::text
          AND log.action = 'attendance.record.create'
        ORDER BY log.occurred_at DESC, log.id DESC
        LIMIT 1
      ) audit ON TRUE
      WHERE attendance.work_date BETWEEN ${input.from}::date AND ${input.to}::date
        AND attendance.work_date <= ${input.today}::date
        AND attendance.record_status = 'ACTIVE'
    ), attendance_by_shift AS (
      SELECT
        attendance.employee_id,
        attendance.shift_assignment_id,
        attendance.work_date,
        BOOL_OR(attendance.validation_status IN ('PENDING_VERIFICATION', 'PENDING_OFFLINE')) AS has_pending,
        BOOL_OR(attendance.validation_status = 'PENDING_VERIFICATION') AS has_pending_verification,
        BOOL_OR(attendance.validation_status = 'PENDING_OFFLINE') AS has_pending_offline,
        BOOL_OR(attendance.validation_status = 'REJECTED') AS has_rejected,
        BOOL_OR(attendance.type = 'CHECK_IN' AND attendance.validation_status IN ('VALID', 'APPROVED')) AS has_valid_check_in,
        MIN(attendance.server_time) FILTER (
          WHERE attendance.type = 'CHECK_IN' AND attendance.validation_status IN ('VALID', 'APPROVED')
        ) AS check_in_at,
        MAX(attendance.server_time) FILTER (
          WHERE attendance.type = 'CHECK_OUT' AND attendance.validation_status IN ('VALID', 'APPROVED')
        ) AS check_out_at,
        BOOL_OR(attendance.type = 'CHECK_IN' AND attendance.validation_status IN ('VALID', 'APPROVED') AND attendance.was_late) AS is_late,
        MAX(attendance.minutes_after_scheduled_start) FILTER (
          WHERE attendance.type = 'CHECK_IN'
            AND attendance.validation_status IN ('VALID', 'APPROVED')
            AND attendance.was_late
        ) AS late_minutes,
        (ARRAY_AGG(attendance.validation_status::text ORDER BY attendance.server_time, attendance.id)
          FILTER (WHERE attendance.type = 'CHECK_IN'))[1] AS check_in_validation_status,
        (ARRAY_AGG(attendance.validation_status::text ORDER BY attendance.server_time, attendance.id)
          FILTER (WHERE attendance.type = 'CHECK_OUT'))[1] AS check_out_validation_status
      FROM attendance_timing attendance
      WHERE attendance.shift_assignment_id IS NOT NULL
      GROUP BY attendance.employee_id, attendance.shift_assignment_id, attendance.work_date
    ), request_by_shift AS (
      SELECT
        schedule.shift_assignment_id,
        schedule.employee_id,
        schedule.work_date,
        COALESCE(BOOL_OR(request.status = 'APPROVED' AND request.request_type = 'LEAVE'), FALSE) AS has_leave,
        COALESCE(BOOL_OR(request.status = 'APPROVED' AND request.request_type = 'SICK'), FALSE) AS has_sick,
        COALESCE(BOOL_OR(request.status = 'APPROVED' AND request.request_type = 'ANNUAL_LEAVE'), FALSE) AS has_annual_leave,
        COALESCE(BOOL_OR(request.status = 'PENDING'), FALSE) AS has_pending_request
      FROM schedule
      LEFT JOIN attendance_requests request
        ON request.employee_id = schedule.employee_id
       AND request.start_date <= schedule.work_date
       AND request.end_date >= schedule.work_date
       AND request.status IN ('PENDING', 'APPROVED')
       AND request.request_type IN ('LEAVE', 'SICK', 'ANNUAL_LEAVE', 'CORRECTION')
      GROUP BY schedule.shift_assignment_id, schedule.employee_id, schedule.work_date
    ), status_rows AS (
      SELECT
        schedule.work_date,
        schedule.shift_assignment_id,
        schedule.employee_id,
        schedule.employee_name,
        schedule.store_id,
        schedule.store_name,
        schedule.shift_id,
        schedule.shift_name,
        schedule.shift_break_minutes,
        schedule.is_holiday,
        schedule.scheduled_start_time,
        schedule.scheduled_end_time,
        attendance.check_in_at,
        attendance.check_out_at,
        attendance.late_minutes,
        attendance.is_late AS has_late_check_in,
        attendance.has_pending,
        attendance.has_pending_verification,
        attendance.has_pending_offline,
        attendance.has_rejected,
        attendance.check_in_validation_status,
        attendance.check_out_validation_status,
        CASE
          WHEN schedule.is_holiday THEN 'HOLIDAY'
          WHEN schedule.work_date > ${input.today}::date THEN 'NOT_STARTED'
          WHEN COALESCE(attendance.has_pending, FALSE) THEN 'WAITING_VERIFICATION'
          WHEN COALESCE(attendance.has_valid_check_in, FALSE) THEN
            CASE
              WHEN attendance.check_out_at IS NULL THEN 'MISSING_CHECKOUT'
              WHEN COALESCE(attendance.is_late, FALSE) THEN 'LATE'
              ELSE 'PRESENT'
            END
          WHEN ${input.ignoreCorrections !== true}
            AND daily.corrected_by_attendance_correction_id IS NOT NULL THEN daily.status::text
          WHEN request.has_leave THEN 'LEAVE'
          WHEN request.has_sick THEN 'SICK'
          WHEN request.has_annual_leave THEN 'ANNUAL_LEAVE'
          WHEN request.has_pending_request THEN 'REQUEST_PENDING'
          WHEN daily.status = 'ABSENT'
            AND (${input.ignoreCorrections !== true} OR daily.corrected_by_attendance_correction_id IS NULL) THEN 'ABSENT'
          WHEN daily.status IN ('EARLY_LEAVE', 'MISSING_CHECKOUT', 'WAITING_VERIFICATION', 'PRESENT', 'LATE')
            AND (${input.ignoreCorrections !== true} OR daily.corrected_by_attendance_correction_id IS NULL) THEN daily.status::text
          WHEN EXISTS (
            SELECT 1 FROM attendance_timing unattributed
            WHERE unattributed.employee_id = schedule.employee_id
              AND unattributed.work_date = schedule.work_date
              AND unattributed.shift_assignment_id IS NULL
              AND unattributed.validation_status IN ('VALID', 'APPROVED', 'PENDING_VERIFICATION', 'PENDING_OFFLINE')
          ) THEN 'UNATTRIBUTED_ATTENDANCE'
          ELSE 'NOT_CHECKED_IN'
        END AS status
      FROM schedule
      LEFT JOIN attendance_by_shift attendance
        ON attendance.employee_id = schedule.employee_id
       AND attendance.shift_assignment_id = schedule.shift_assignment_id
       AND attendance.work_date = schedule.work_date
      LEFT JOIN daily_attendance_statuses daily
        ON daily.employee_id = schedule.employee_id
       AND daily.shift_assignment_id = schedule.shift_assignment_id
       AND daily.work_date = schedule.work_date
      LEFT JOIN request_by_shift request
        ON request.employee_id = schedule.employee_id
       AND request.shift_assignment_id = schedule.shift_assignment_id
       AND request.work_date = schedule.work_date
    )
  `;
}

function pageBounds(filter: DashboardFilter & { page: number; pageSize: number }) {
  return {
    offset: (filter.page - 1) * filter.pageSize,
    take: filter.pageSize + 1,
  };
}

export class PrismaDashboardRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async adminDashboard(input: {
    actor: DashboardActor;
    filter: DashboardFilter & { date: string; page: number; pageSize: number };
    today: string;
  }): Promise<DashboardData> {
    let scopedStoreIds: readonly string[] | null = null;
    if (input.actor.role === UserRole.SUPERVISOR) {
      const assignments = await this.prisma.supervisorStoreAssignment.findMany({
        where: { supervisorUserAccountId: input.actor.userAccountId },
        select: { storeId: true },
      });
      scopedStoreIds = [...new Set(assignments.map(({ storeId }) => storeId))];
    }
    const from = subtractCalendarDays(input.filter.date, 29);
    const cte = statusRowsCte({
      ...input.filter,
      from,
      to: input.filter.date,
      today: input.today,
      scopedStoreIds,
    });
    const bounds = pageBounds(input.filter);

    const [summaryRows, absentRows, trendRows, rankingRows] = await Promise.all([
      this.prisma.$queryRaw<readonly SummaryRow[]>(Prisma.sql`
        ${cte}
        SELECT
          COUNT(*) FILTER (WHERE status <> 'HOLIDAY') AS "scheduledShifts",
          COUNT(*) FILTER (WHERE status = 'PRESENT') AS present,
          COUNT(*) FILTER (WHERE status = 'LATE') AS late,
          COUNT(*) FILTER (WHERE status = 'NOT_CHECKED_IN') AS "notCheckedIn",
          COUNT(*) FILTER (WHERE status = 'ABSENT') AS absent,
          COUNT(*) FILTER (WHERE status = 'LEAVE') AS leave,
          COUNT(*) FILTER (WHERE status = 'SICK') AS sick,
          COUNT(*) FILTER (WHERE status = 'ANNUAL_LEAVE') AS "annualLeave",
          COUNT(*) FILTER (WHERE status = 'WAITING_VERIFICATION') AS "waitingVerification",
          COUNT(*) FILTER (WHERE status = 'REQUEST_PENDING') AS "pendingRequests"
        FROM status_rows
        WHERE work_date = ${input.filter.date}::date
      `),
      this.prisma.$queryRaw<readonly ShiftRow[]>(Prisma.sql`
        ${cte}
        SELECT
          employee_id AS "employeeId",
          employee_name AS "employeeName",
          shift_assignment_id AS "shiftAssignmentId",
          shift_id AS "shiftId",
          shift_name AS "shiftName",
          scheduled_start_time AS "scheduledStartTime",
          scheduled_end_time AS "scheduledEndTime",
          store_id AS "storeId",
          store_name AS "storeName",
          work_date::text AS date,
          status,
          check_in_at AS "checkInAt",
          check_out_at AS "checkOutAt",
          late_minutes AS "minutesAfterScheduledStart"
        FROM status_rows
        WHERE work_date = ${input.filter.date}::date
          AND status IN ('NOT_CHECKED_IN', 'ABSENT')
        ORDER BY employee_name, shift_name, shift_assignment_id
        LIMIT ${bounds.take} OFFSET ${bounds.offset}
      `),
      this.prisma.$queryRaw<readonly TrendRow[]>(Prisma.sql`
        ${cte}
        SELECT
          dates.work_date::text AS date,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status <> 'HOLIDAY') AS "scheduledShifts",
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'PRESENT') AS present,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'LATE') AS late,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'NOT_CHECKED_IN') AS "notCheckedIn",
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'ABSENT') AS absent,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'LEAVE') AS leave,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'SICK') AS sick,
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'ANNUAL_LEAVE') AS "annualLeave",
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'WAITING_VERIFICATION') AS "waitingVerification",
          COUNT(status_rows.shift_assignment_id) FILTER (WHERE status_rows.status = 'REQUEST_PENDING') AS "pendingRequests"
        FROM generate_series(${from}::date, ${input.filter.date}::date, interval '1 day') AS dates(work_date)
        LEFT JOIN status_rows ON status_rows.work_date = dates.work_date
        GROUP BY dates.work_date
        ORDER BY dates.work_date
      `),
      this.prisma.$queryRaw<readonly RankingRow[]>(Prisma.sql`
        ${cte}
        SELECT
          employee_id AS "employeeId",
          MAX(employee_name) AS "employeeName",
          COUNT(*) FILTER (WHERE status = 'LATE') AS "lateCount",
          COUNT(DISTINCT work_date) FILTER (WHERE status = 'LATE') AS "lateDays",
          COALESCE(SUM(late_minutes) FILTER (WHERE status = 'LATE'), 0) AS "totalMinutesAfterScheduledStart"
        FROM status_rows
        GROUP BY employee_id
        HAVING COUNT(*) FILTER (WHERE status = 'LATE') > 0
        ORDER BY "lateCount" DESC, "totalMinutesAfterScheduledStart" DESC, "employeeName" ASC, "employeeId" ASC
        LIMIT 10
      `),
    ]);

    const absentItems = absentRows.slice(0, input.filter.pageSize).map(toShiftItem);
    const trend: DashboardTrendItem[] = trendRows.map((row) => ({
      date: row.date,
      ...summary(row),
    }));
    const lateRanking: DashboardLateRankingItem[] = rankingRows.map((row) => ({
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      lateCount: asCount(row.lateCount),
      lateDays: asCount(row.lateDays),
      totalMinutesAfterScheduledStart: asDecimal(row.totalMinutesAfterScheduledStart) ?? 0,
    }));
    return {
      summary: summary(summaryRows[0]),
      notCheckedIn: {
        items: absentItems,
        page: input.filter.page,
        pageSize: input.filter.pageSize,
        hasNextPage: absentRows.length > input.filter.pageSize,
      },
      trend,
      lateRanking,
    };
  }

  async employeeDashboard(input: {
    userAccountId: string;
    employeeId: string;
    date: string;
    historyPage: number;
    historyPageSize: number;
    historyFrom?: string;
    historyTo?: string;
    requestPage: number;
    requestPageSize: number;
  }) {
    const cte = statusRowsCte({
      from: input.date,
      to: input.date,
      today: input.date,
      scopedStoreIds: null,
      employee: { employeeId: input.employeeId, userAccountId: input.userAccountId },
    });
    const historySkip = (input.historyPage - 1) * input.historyPageSize;
    const requestSkip = (input.requestPage - 1) * input.requestPageSize;
    const historyWhere = {
      employeeId: input.employeeId,
      employee: { is: { accountId: input.userAccountId } },
      recordStatus: 'ACTIVE' as const,
      ...(input.historyFrom === undefined && input.historyTo === undefined
        ? {}
        : {
            workDate: {
              ...(input.historyFrom === undefined
                ? {}
                : { gte: prismaDateOnly(input.historyFrom) }),
              ...(input.historyTo === undefined ? {} : { lte: prismaDateOnly(input.historyTo) }),
            },
          }),
    };
    const [todayRows, historyRows, requestRows] = await Promise.all([
      this.prisma.$queryRaw<readonly ShiftRow[]>(Prisma.sql`
        ${cte}
        SELECT
          employee_id AS "employeeId",
          employee_name AS "employeeName",
          shift_assignment_id AS "shiftAssignmentId",
          shift_id AS "shiftId",
          shift_name AS "shiftName",
          scheduled_start_time AS "scheduledStartTime",
          scheduled_end_time AS "scheduledEndTime",
          store_id AS "storeId",
          store_name AS "storeName",
          work_date::text AS date,
          status,
          check_in_at AS "checkInAt",
          check_out_at AS "checkOutAt",
          late_minutes AS "minutesAfterScheduledStart"
        FROM status_rows
        ORDER BY shift_name, shift_assignment_id
      `),
      this.prisma.attendance.findMany({
        where: historyWhere,
        orderBy: [{ workDate: 'desc' }, { serverTime: 'desc' }, { id: 'desc' }],
        skip: historySkip,
        take: input.historyPageSize + 1,
        select: {
          id: true,
          workDate: true,
          type: true,
          serverTime: true,
          validationStatus: true,
          store: { select: { id: true, name: true } },
          shiftAssignment: { select: { id: true, workShift: { select: { name: true } } } },
        },
      }),
      this.prisma.attendanceRequest.findMany({
        where: {
          employeeId: input.employeeId,
          employee: { is: { accountId: input.userAccountId } },
        },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: requestSkip,
        take: input.requestPageSize + 1,
        select: {
          id: true,
          requestType: true,
          startDate: true,
          endDate: true,
          status: true,
          requestedAt: true,
          decisionAt: true,
        },
      }),
    ]);
    const toDate = (date: Date) => date.toISOString().slice(0, 10);
    const historyItems: EmployeeHistoryItem[] = historyRows
      .slice(0, input.historyPageSize)
      .map((row) => ({
        id: row.id,
        date: toDate(row.workDate),
        type: row.type,
        serverTime: row.serverTime.toISOString(),
        validationStatus: row.validationStatus,
        store: row.store,
        shift: row.shiftAssignment
          ? { id: row.shiftAssignment.id, name: row.shiftAssignment.workShift.name }
          : null,
      }));
    const requestItems: EmployeeRequestStatusItem[] = requestRows
      .slice(0, input.requestPageSize)
      .map((row) => ({
        id: row.id,
        requestType: row.requestType,
        startDate: toDate(row.startDate),
        endDate: toDate(row.endDate),
        status: row.status,
        requestedAt: row.requestedAt.toISOString(),
        decisionAt: row.decisionAt?.toISOString() ?? null,
      }));
    return {
      today: todayRows.map(toShiftItem),
      history: {
        items: historyItems,
        page: input.historyPage,
        pageSize: input.historyPageSize,
        hasNextPage: historyRows.length > input.historyPageSize,
      },
      requests: {
        items: requestItems,
        page: input.requestPage,
        pageSize: input.requestPageSize,
        hasNextPage: requestRows.length > input.requestPageSize,
      },
    };
  }
}
