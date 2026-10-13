import { AttendanceValidationStatus, DailyAttendanceStatus } from '../../generated/prisma/enums.js';
import { businessDateTime } from '../attendance/business-rules.js';
import { getBusinessDateAndWeekday, isWorkingDay, resolveShiftEnd } from '../time/index.js';

export type DailyShiftInstance = Readonly<{
  employeeId: string;
  shiftAssignmentId: string;
  storeId: string | null;
  workDate: string;
  startTime: string;
  endTime: string;
  workDays: readonly number[];
  holidayDates: readonly string[];
  hasAmbiguousStoreHoliday: boolean;
}>;

export type DailyAttendanceCorrection = Readonly<{
  correctionId: string;
  employeeId: string;
  shiftAssignmentId: string;
  workDate: string;
}>;

export type DailyAbsentResult =
  | 'created'
  | 'blocked'
  | 'closed'
  | 'schedule_changed'
  | 'not_due'
  | 'non_working'
  | 'ambiguous_holiday'
  | 'exists';

export interface DailyAttendanceRepository {
  listShiftInstances(workDates: readonly string[]): Promise<readonly DailyShiftInstance[]>;
  markAbsentIfEligible(
    input: Readonly<{ shift: DailyShiftInstance; evaluatedAt: Date }>,
  ): Promise<DailyAbsentResult>;
  applyApprovedCorrection(input: DailyAttendanceCorrection): Promise<boolean>;
}

export type DailyAttendanceJobResult = Readonly<{
  scanned: number;
  notDue: number;
  nonWorking: number;
  ambiguousHoliday: number;
  absentCreated: number;
  blocked: number;
  closed: number;
  alreadyExists: number;
  scheduleChanged: number;
}>;

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function absentCutoff(shift: DailyShiftInstance): Date {
  const shiftEnd = resolveShiftEnd(shift.workDate, shift.startTime, shift.endTime);
  return new Date(
    businessDateTime(shiftEnd.businessDate, shiftEnd.clockTime).getTime() + 2 * 60 * 60 * 1000,
  );
}

/** Map an accepted attendance to its derived daily state without changing raw evidence. */
export function dailyStatusForAttendance(
  validationStatus: AttendanceValidationStatus,
  isLate: boolean,
): DailyAttendanceStatus | null {
  if (
    validationStatus === AttendanceValidationStatus.PENDING_VERIFICATION ||
    validationStatus === AttendanceValidationStatus.PENDING_OFFLINE
  ) {
    return DailyAttendanceStatus.WAITING_VERIFICATION;
  }
  if (
    validationStatus === AttendanceValidationStatus.VALID ||
    validationStatus === AttendanceValidationStatus.APPROVED
  ) {
    return isLate ? DailyAttendanceStatus.LATE : DailyAttendanceStatus.PRESENT;
  }
  return null;
}

export class DailyAttendanceService {
  constructor(private readonly repository: DailyAttendanceRepository) {}

  async runAbsentJob(now: Date = new Date()): Promise<DailyAttendanceJobResult> {
    if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date.');
    const today = getBusinessDateAndWeekday(now).businessDate;
    // Shifts may end almost 24 hours after their work date, then receive the two-hour grace.
    const workDates = [-2, -1, 0].map((offset) => addCalendarDays(today, offset));
    const shifts = await this.repository.listShiftInstances(workDates);
    const result = {
      scanned: shifts.length,
      notDue: 0,
      nonWorking: 0,
      ambiguousHoliday: 0,
      absentCreated: 0,
      blocked: 0,
      closed: 0,
      alreadyExists: 0,
      scheduleChanged: 0,
    };

    for (const shift of shifts) {
      if (absentCutoff(shift).getTime() > now.getTime()) {
        result.notDue += 1;
        continue;
      }
      if (shift.hasAmbiguousStoreHoliday) {
        result.ambiguousHoliday += 1;
        continue;
      }
      if (!isWorkingDay(shift.workDate, shift.workDays, shift.holidayDates)) {
        result.nonWorking += 1;
        continue;
      }

      const outcome = await this.repository.markAbsentIfEligible({ shift, evaluatedAt: now });
      if (outcome === 'created') result.absentCreated += 1;
      else if (outcome === 'blocked') result.blocked += 1;
      else if (outcome === 'closed') result.closed += 1;
      else if (outcome === 'exists') result.alreadyExists += 1;
      else if (outcome === 'not_due') result.notDue += 1;
      else if (outcome === 'non_working') result.nonWorking += 1;
      else if (outcome === 'ambiguous_holiday') result.ambiguousHoliday += 1;
      else result.scheduleChanged += 1;
    }

    return result;
  }

  applyApprovedCorrection(input: DailyAttendanceCorrection): Promise<boolean> {
    return this.repository.applyApprovedCorrection(input);
  }
}
