import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { assessAttendanceTiming } from '../attendance/business-rules.js';
import type {
  DailyAbsentResult,
  DailyAttendanceCorrection,
  DailyAttendanceRepository,
  DailyShiftInstance,
} from './index.js';

type ShiftInstanceRow = Readonly<{
  employeeId: string;
  shiftAssignmentId: string;
  storeId: string | null;
  workDate: string;
  startTime: string;
  endTime: string;
  workDays: number[];
  holidayDates: string[];
  hasAmbiguousStoreHoliday: boolean;
}>;

type AbsentGuardRow = Readonly<{
  scheduleMissing: boolean;
  notDue: boolean;
  nonWorking: boolean;
  ambiguousStoreHoliday: boolean;
  attendanceExists: boolean;
  requestExists: boolean;
  correctionExists: boolean;
  pendingAttemptExists: boolean;
  disruptionExists: boolean;
  closed: boolean;
}>;

function first<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

export class PrismaDailyAttendanceRepository implements DailyAttendanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listShiftInstances(workDates: readonly string[]): Promise<readonly DailyShiftInstance[]> {
    if (workDates.length === 0) return [];
    const rows = await this.prisma.$queryRaw<readonly ShiftInstanceRow[]>(Prisma.sql`
      WITH work_dates AS (
        SELECT value::date AS work_date
        FROM unnest(${workDates}::text[]) AS value
      )
      SELECT
        sa.employee_id::text AS "employeeId",
        sa.id::text AS "shiftAssignmentId",
        sa.store_id::text AS "storeId",
        work_dates.work_date::text AS "workDate",
        ws.start_time::text AS "startTime",
        ws.end_time::text AS "endTime",
        ws.work_days AS "workDays",
        ARRAY(
          SELECT DISTINCT holiday.holiday_date::text
          FROM holidays AS holiday
          WHERE holiday.holiday_date = work_dates.work_date
            AND (
              holiday.store_id IS NULL
              OR holiday.store_id = sa.store_id
            )
        ) AS "holidayDates",
        EXISTS (
          SELECT 1
          FROM holidays AS local_holiday
          INNER JOIN employee_stores AS employee_store
            ON employee_store.employee_id = sa.employee_id
           AND employee_store.store_id = local_holiday.store_id
          INNER JOIN stores AS assigned_store
            ON assigned_store.id = employee_store.store_id
           AND assigned_store.is_active = TRUE
          WHERE sa.store_id IS NULL
            AND local_holiday.holiday_date = work_dates.work_date
            AND local_holiday.store_id IS NOT NULL
        ) AS "hasAmbiguousStoreHoliday"
      FROM work_dates
      INNER JOIN shift_assignments AS sa
        ON sa.effective_from <= work_dates.work_date
        AND (sa.effective_to IS NULL OR sa.effective_to >= work_dates.work_date)
      INNER JOIN work_shifts AS ws ON ws.id = sa.work_shift_id AND ws.is_active = TRUE
      INNER JOIN employees AS employee ON employee.id = sa.employee_id AND employee.status = 'ACTIVE'
      WHERE sa.store_id IS NULL OR EXISTS (
        SELECT 1
        FROM employee_stores AS employee_store
        INNER JOIN stores AS store ON store.id = employee_store.store_id AND store.is_active = TRUE
        WHERE employee_store.employee_id = sa.employee_id
          AND employee_store.store_id = sa.store_id
      )
      ORDER BY work_dates.work_date, sa.employee_id, sa.id
    `);
    return rows;
  }

  async markAbsentIfEligible(input: {
    shift: DailyShiftInstance;
    evaluatedAt: Date;
  }): Promise<DailyAbsentResult> {
    const { shift, evaluatedAt } = input;
    return this.prisma.$transaction(async (transaction) => {
      const employeeLock = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT id::text AS id
        FROM employees
        WHERE id = ${shift.employeeId}::uuid
        FOR UPDATE
      `);
      if (employeeLock.length === 0) return 'schedule_changed';

      const guardRows = await transaction.$queryRaw<readonly AbsentGuardRow[]>(Prisma.sql`
        WITH schedule AS (
          SELECT
            sa.id,
            sa.employee_id,
            sa.store_id,
            ws.start_time,
            ws.end_time,
            ws.work_days
          FROM shift_assignments AS sa
          INNER JOIN work_shifts AS ws ON ws.id = sa.work_shift_id
          WHERE sa.id = ${shift.shiftAssignmentId}::uuid
            AND sa.employee_id = ${shift.employeeId}::uuid
            AND sa.effective_from <= ${shift.workDate}::date
            AND (sa.effective_to IS NULL OR sa.effective_to >= ${shift.workDate}::date)
            AND ws.is_active = TRUE
          FOR SHARE OF sa, ws
        ), shift_window AS (
          SELECT
            schedule.*,
            ((${shift.workDate}::date + schedule.start_time) AT TIME ZONE 'Asia/Jakarta') AS starts_at,
            ((${shift.workDate}::date + schedule.end_time
              + CASE WHEN schedule.end_time < schedule.start_time THEN interval '1 day' ELSE interval '0' END
            ) AT TIME ZONE 'Asia/Jakarta') AS ends_at,
            EXTRACT(ISODOW FROM ${shift.workDate}::date)::integer = ANY(schedule.work_days) AS weekday_working,
            EXISTS (
              SELECT 1
              FROM holidays AS holiday
              WHERE holiday.holiday_date = ${shift.workDate}::date
                AND (holiday.store_id IS NULL OR holiday.store_id = schedule.store_id)
            ) AS holiday,
            schedule.store_id IS NULL AND EXISTS (
              SELECT 1
              FROM holidays AS local_holiday
              INNER JOIN employee_stores AS employee_store
                ON employee_store.employee_id = schedule.employee_id
               AND employee_store.store_id = local_holiday.store_id
              INNER JOIN stores AS assigned_store
                ON assigned_store.id = employee_store.store_id
               AND assigned_store.is_active = TRUE
              WHERE local_holiday.holiday_date = ${shift.workDate}::date
                AND local_holiday.store_id IS NOT NULL
            ) AS ambiguous_store_holiday
          FROM schedule
        )
        SELECT
          NOT EXISTS (SELECT 1 FROM schedule) AS "scheduleMissing",
          NOT EXISTS (
            SELECT 1 FROM shift_window
            WHERE weekday_working
              AND NOT holiday
              AND NOT ambiguous_store_holiday
              AND ends_at + interval '2 hours' <= ${evaluatedAt}
          ) AS "notDue",
          EXISTS (
            SELECT 1 FROM shift_window
            WHERE NOT weekday_working OR holiday
          ) AS "nonWorking",
          EXISTS (
            SELECT 1 FROM shift_window WHERE ambiguous_store_holiday
          ) AS "ambiguousStoreHoliday",
          EXISTS (
            SELECT 1
            FROM attendances AS attendance
            WHERE attendance.employee_id = ${shift.employeeId}::uuid
              AND attendance.work_date = ${shift.workDate}::date
              AND (attendance.shift_assignment_id = ${shift.shiftAssignmentId}::uuid
                   OR attendance.shift_assignment_id IS NULL)
              AND attendance.record_status = 'ACTIVE'
              AND attendance.validation_status IN (
                'VALID', 'APPROVED', 'PENDING_VERIFICATION', 'PENDING_OFFLINE'
              )
          ) AS "attendanceExists",
          EXISTS (
            SELECT 1
            FROM attendance_requests AS request
            WHERE request.employee_id = ${shift.employeeId}::uuid
              AND request.start_date <= ${shift.workDate}::date
              AND request.end_date >= ${shift.workDate}::date
              AND request.status IN ('PENDING', 'APPROVED')
              AND request.request_type IN ('LEAVE', 'SICK', 'ANNUAL_LEAVE', 'CORRECTION')
          ) AS "requestExists",
          EXISTS (
            SELECT 1
            FROM attendance_corrections AS correction
            WHERE correction.status = 'PENDING'
              AND correction.requested_by_employee_id = ${shift.employeeId}::uuid
              AND (
                EXISTS (
                  SELECT 1
                  FROM attendances AS attendance
                  WHERE attendance.id = correction.attendance_id
                    AND attendance.employee_id = ${shift.employeeId}::uuid
                    AND attendance.work_date = ${shift.workDate}::date
                    AND (attendance.shift_assignment_id = ${shift.shiftAssignmentId}::uuid
                         OR attendance.shift_assignment_id IS NULL)
                )
                OR EXISTS (
                  SELECT 1
                  FROM attendance_requests AS request
                  WHERE request.id = correction.attendance_request_id
                    AND request.employee_id = ${shift.employeeId}::uuid
                    AND request.request_type = 'CORRECTION'
                    AND request.start_date <= ${shift.workDate}::date
                    AND request.end_date >= ${shift.workDate}::date
                )
              )
          ) AS "correctionExists",
          EXISTS (
            SELECT 1
            FROM attendance_attempts AS attempt
            CROSS JOIN shift_window
            WHERE attempt.employee_id = ${shift.employeeId}::uuid
              AND attempt.processing_status = 'RECEIVED'
              AND attempt.received_at >= shift_window.starts_at
              AND attempt.received_at <= shift_window.ends_at + interval '2 hours'
              AND attempt.received_at <= ${evaluatedAt}
              AND (
                attempt.store_id IS NULL
                OR shift_window.store_id IS NULL
                OR attempt.store_id = shift_window.store_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM attendances AS attendance
                WHERE attendance.source_attempt_id = attempt.id
              )
          ) AS "pendingAttemptExists",
          EXISTS (
            SELECT 1
            FROM system_disruptions AS disruption
            CROSS JOIN shift_window
            WHERE disruption.is_active = TRUE
              AND disruption.starts_at < shift_window.ends_at
              AND disruption.ends_at > shift_window.starts_at
              AND (
                disruption.store_id IS NULL
                OR disruption.store_id = shift_window.store_id
                OR (
                  shift_window.store_id IS NULL
                  AND EXISTS (
                    SELECT 1
                    FROM employee_stores AS employee_store
                    WHERE employee_store.employee_id = shift_window.employee_id
                      AND employee_store.store_id = disruption.store_id
                  )
                )
              )
          ) AS "disruptionExists",
          EXISTS (
            SELECT 1
            FROM monthly_recaps AS recap
            CROSS JOIN shift_window
            WHERE recap.employee_id = ${shift.employeeId}::uuid
              AND recap.period_start = date_trunc('month', ${shift.workDate}::date)::date
              AND recap.status = 'CLOSED'
              AND (
                recap.store_id IS NULL
                OR recap.store_id = shift_window.store_id
                OR shift_window.store_id IS NULL
              )
          ) AS closed
      `);
      const guard = first(guardRows);
      if (!guard || guard.scheduleMissing) return 'schedule_changed';
      if (guard.closed) return 'closed';
      if (guard.ambiguousStoreHoliday) return 'ambiguous_holiday';
      if (guard.nonWorking) return 'non_working';
      if (guard.notDue) return 'not_due';
      if (
        guard.attendanceExists ||
        guard.requestExists ||
        guard.correctionExists ||
        guard.pendingAttemptExists ||
        guard.disruptionExists
      ) {
        return 'blocked';
      }

      const inserted = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        INSERT INTO daily_attendance_statuses (
          id, employee_id, shift_assignment_id, work_date, status, evaluated_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${shift.employeeId}::uuid,
          ${shift.shiftAssignmentId}::uuid,
          ${shift.workDate}::date,
          'ABSENT'::daily_attendance_status,
          ${evaluatedAt}
        )
        ON CONFLICT (employee_id, shift_assignment_id, work_date) DO NOTHING
        RETURNING id::text AS id
      `);
      return inserted.length === 0 ? 'exists' : 'created';
    });
  }

  async applyApprovedCorrection(input: DailyAttendanceCorrection): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const employeeLock = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT id::text AS id
        FROM employees
        WHERE id = ${input.employeeId}::uuid
        FOR UPDATE
      `);
      if (employeeLock.length === 0) return false;

      const validationRows = await transaction.$queryRaw<
        readonly {
          scheduleMissing: boolean;
          approvedCorrection: boolean;
          closed: boolean;
          checkInServerTime: Date | null;
          startTime: string | null;
          endTime: string | null;
          lateToleranceMinutes: number | null;
        }[]
      >(Prisma.sql`
        WITH schedule AS (
          SELECT
            sa.id,
            sa.employee_id,
            sa.store_id,
            ws.start_time::text AS start_time,
            ws.end_time::text AS end_time,
            ws.late_tolerance_minutes
          FROM shift_assignments AS sa
          INNER JOIN work_shifts AS ws ON ws.id = sa.work_shift_id AND ws.is_active = TRUE
          WHERE sa.id = ${input.shiftAssignmentId}::uuid
            AND sa.employee_id = ${input.employeeId}::uuid
            AND sa.effective_from <= ${input.workDate}::date
            AND (sa.effective_to IS NULL OR sa.effective_to >= ${input.workDate}::date)
          FOR SHARE OF sa
        ), approved_correction AS (
          SELECT
            correction.proposed_server_time,
            schedule.start_time,
            schedule.end_time,
            schedule.late_tolerance_minutes
          FROM attendance_corrections AS correction
          CROSS JOIN schedule
          LEFT JOIN attendance_requests AS request
            ON request.id = correction.attendance_request_id
          WHERE correction.id = ${input.correctionId}::uuid
            AND correction.requested_by_employee_id = ${input.employeeId}::uuid
            AND correction.status = 'APPROVED'
            AND correction.proposed_type = 'CHECK_IN'
            AND correction.proposed_server_time IS NOT NULL
            AND (
              (
                correction.attendance_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM attendances AS attendance
                  WHERE attendance.id = correction.attendance_id
                    AND attendance.employee_id = ${input.employeeId}::uuid
                    AND attendance.work_date = ${input.workDate}::date
                    AND (attendance.shift_assignment_id = ${input.shiftAssignmentId}::uuid
                         OR attendance.shift_assignment_id IS NULL)
                )
              )
              OR (
                request.id IS NOT NULL
                AND request.employee_id = ${input.employeeId}::uuid
                AND request.request_type = 'CORRECTION'
                AND request.status = 'APPROVED'
                AND request.start_date <= ${input.workDate}::date
                AND request.end_date >= ${input.workDate}::date
              )
            )
            AND (
              correction.proposed_store_id IS NULL
              OR correction.proposed_store_id = schedule.store_id
              OR (
                schedule.store_id IS NULL
                AND EXISTS (
                  SELECT 1 FROM employee_stores AS employee_store
                  WHERE employee_store.employee_id = schedule.employee_id
                    AND employee_store.store_id = correction.proposed_store_id
                )
              )
            )
        )
        SELECT
          NOT EXISTS (SELECT 1 FROM schedule) AS "scheduleMissing",
          EXISTS (SELECT 1 FROM approved_correction) AS "approvedCorrection",
          (SELECT proposed_server_time FROM approved_correction LIMIT 1) AS "checkInServerTime",
          (SELECT start_time FROM approved_correction LIMIT 1) AS "startTime",
          (SELECT end_time FROM approved_correction LIMIT 1) AS "endTime",
          (SELECT late_tolerance_minutes FROM approved_correction LIMIT 1) AS "lateToleranceMinutes",
          EXISTS (
            SELECT 1
            FROM monthly_recaps AS recap
            CROSS JOIN schedule
            WHERE recap.employee_id = ${input.employeeId}::uuid
              AND recap.period_start = date_trunc('month', ${input.workDate}::date)::date
              AND recap.status = 'CLOSED'
              AND (
                recap.store_id IS NULL
                OR recap.store_id = schedule.store_id
                OR schedule.store_id IS NULL
              )
          ) AS closed
      `);
      const validation = first(validationRows);
      if (
        !validation ||
        validation.scheduleMissing ||
        validation.closed ||
        !validation.approvedCorrection
      ) {
        return false;
      }

      if (
        !validation.checkInServerTime ||
        !validation.startTime ||
        !validation.endTime ||
        validation.lateToleranceMinutes === null
      ) {
        return false;
      }
      const timing = assessAttendanceTiming({
        workDate: input.workDate,
        shiftStart: validation.startTime,
        shiftEnd: validation.endTime,
        toleranceMinutes: validation.lateToleranceMinutes,
        checkInServerTime: validation.checkInServerTime,
        checkOutServerTime: null,
        hasApprovedLeave: false,
      });
      const status = timing.isLate ? 'LATE' : 'PRESENT';

      const written = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        INSERT INTO daily_attendance_statuses (
          id, employee_id, shift_assignment_id, work_date, status,
          evaluated_at, corrected_by_attendance_correction_id
        ) VALUES (
          ${randomUUID()}::uuid,
          ${input.employeeId}::uuid,
          ${input.shiftAssignmentId}::uuid,
          ${input.workDate}::date,
          ${status}::daily_attendance_status,
          CURRENT_TIMESTAMP,
          ${input.correctionId}::uuid
        )
        ON CONFLICT (employee_id, shift_assignment_id, work_date)
        DO UPDATE SET
          status = EXCLUDED.status,
          evaluated_at = EXCLUDED.evaluated_at,
          corrected_by_attendance_correction_id = EXCLUDED.corrected_by_attendance_correction_id,
          updated_at = CURRENT_TIMESTAMP
        WHERE NOT EXISTS (
          SELECT 1 FROM monthly_recaps AS recap
          WHERE recap.employee_id = ${input.employeeId}::uuid
            AND recap.period_start = date_trunc('month', ${input.workDate}::date)::date
            AND recap.status = 'CLOSED'
            AND (
              recap.store_id IS NULL
              OR recap.store_id = (
                SELECT store_id FROM shift_assignments
                WHERE id = ${input.shiftAssignmentId}::uuid
              )
              OR (SELECT store_id FROM shift_assignments WHERE id = ${input.shiftAssignmentId}::uuid) IS NULL
            )
        )
        RETURNING id::text AS id
      `);
      return written.length === 1;
    });
  }
}
