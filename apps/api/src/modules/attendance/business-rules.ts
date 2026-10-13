import type { AttendanceValidationStatus } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import {
  assertBusinessDate,
  assertValidClockTime,
  calculateCheckInLateness,
  resolveShiftEnd,
  type BusinessDate,
  type ClockTime,
  type Instant,
} from '../time/index.js';

export type AttendanceBusinessRuleErrorCode =
  | 'ATTENDANCE_CHECK_IN_DUPLICATE'
  | 'ATTENDANCE_CHECK_IN_REQUIRED'
  | 'ATTENDANCE_CHECKOUT_SHIFT_MISMATCH'
  | 'ATTENDANCE_CHECKOUT_OUT_OF_ORDER'
  | 'ATTENDANCE_CHECKOUT_WINDOW_EXPIRED'
  | 'ATTENDANCE_SHIFT_NOT_ASSIGNED'
  | 'ATTENDANCE_SHIFT_AMBIGUOUS'
  | 'ATTENDANCE_NON_WORKING_DAY';

const businessRuleMessages: Record<AttendanceBusinessRuleErrorCode, string> = {
  ATTENDANCE_CHECK_IN_DUPLICATE:
    'Check-in valid sudah tercatat. Ajukan koreksi jika data absensi perlu diperbaiki.',
  ATTENDANCE_CHECK_IN_REQUIRED:
    'Check-in untuk shift ini tidak ditemukan. Jangan membuat check-out; ajukan koreksi absensi.',
  ATTENDANCE_CHECKOUT_SHIFT_MISMATCH:
    'Check-out harus menggunakan shift dan tanggal kerja yang memiliki check-in.',
  ATTENDANCE_CHECKOUT_OUT_OF_ORDER:
    'Waktu server check-out harus setelah check-in pada shift yang sama.',
  ATTENDANCE_CHECKOUT_WINDOW_EXPIRED:
    'Jadwal shift malam sudah berakhir. Ajukan koreksi absensi; check-out tidak ditautkan otomatis.',
  ATTENDANCE_SHIFT_NOT_ASSIGNED:
    'Tidak ada shift kerja aktif untuk waktu ini. Hubungi Admin atau ajukan koreksi absensi.',
  ATTENDANCE_SHIFT_AMBIGUOUS:
    'Jadwal shift untuk waktu ini tidak tunggal. Hubungi Admin sebelum melanjutkan.',
  ATTENDANCE_NON_WORKING_DAY: 'Tanggal ini bukan hari kerja pada shift yang ditugaskan.',
};

export function attendanceBusinessRuleError(code: AttendanceBusinessRuleErrorCode): AppError {
  return new AppError(409, code, businessRuleMessages[code]);
}

export function attendanceBusinessRuleErrorFromCode(code: string | null): AppError | null {
  if (!code || !isAttendanceBusinessRuleErrorCode(code)) return null;
  return attendanceBusinessRuleError(code);
}

export function isAttendanceBusinessRuleErrorCode(
  code: string,
): code is AttendanceBusinessRuleErrorCode {
  return Object.hasOwn(businessRuleMessages, code);
}

export function assertNoValidCheckInDuplicate(duplicateExists: boolean): void {
  if (duplicateExists) throw attendanceBusinessRuleError('ATTENDANCE_CHECK_IN_DUPLICATE');
}

export type ExistingCheckIn = Readonly<{
  shiftAssignmentId: string | null;
  workDate: string;
  serverTime: Date;
  validationStatus: AttendanceValidationStatus;
  recordStatus: 'ACTIVE' | 'SUPERSEDED';
}>;

export function assertCheckoutFollowsCheckIn(
  input: Readonly<{
    checkIn: ExistingCheckIn | null;
    shiftAssignmentId: string;
    workDate: string;
    serverTime: Date;
  }>,
): void {
  const checkIn = input.checkIn;
  if (!checkIn || checkIn.recordStatus !== 'ACTIVE' || checkIn.validationStatus === 'REJECTED') {
    throw attendanceBusinessRuleError('ATTENDANCE_CHECK_IN_REQUIRED');
  }

  // PENDING_VERIFICATION is an existing, provisional check-in event: it may be
  // paired with checkout, but this does not promote either event to valid/approved.
  // Only REJECTED is ineligible here; final validation remains a separate workflow.

  if (
    checkIn.shiftAssignmentId !== input.shiftAssignmentId ||
    checkIn.workDate !== input.workDate
  ) {
    throw attendanceBusinessRuleError('ATTENDANCE_CHECKOUT_SHIFT_MISMATCH');
  }

  if (checkIn.serverTime.getTime() >= input.serverTime.getTime()) {
    throw attendanceBusinessRuleError('ATTENDANCE_CHECKOUT_OUT_OF_ORDER');
  }
}

export function businessDateTime(date: BusinessDate, time: ClockTime): Date {
  assertBusinessDate(date);
  assertValidClockTime(time);
  const instant = new Date(`${date}T${time}+07:00`);
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Invalid WIB date and time.');
  return instant;
}

export type AttendanceTimingAssessment = Readonly<{
  isLate: boolean;
  minutesAfterScheduledStart: number;
  isEarlyLeave: boolean;
  missingCheckout: boolean;
}>;

export function assessAttendanceTiming(
  input: Readonly<{
    workDate: BusinessDate;
    shiftStart: ClockTime;
    shiftEnd: ClockTime;
    toleranceMinutes: number;
    checkInServerTime: Instant | null;
    checkOutServerTime: Instant | null;
    hasApprovedLeave: boolean;
  }>,
): AttendanceTimingAssessment {
  const shiftEnd = resolveShiftEnd(input.workDate, input.shiftStart, input.shiftEnd);
  const scheduledStart = businessDateTime(input.workDate, input.shiftStart);
  const scheduledEnd = businessDateTime(shiftEnd.businessDate, shiftEnd.clockTime);
  const lateness = input.checkInServerTime
    ? calculateCheckInLateness({
        scheduledStart,
        actualServerTime: input.checkInServerTime,
        toleranceMinutes: input.toleranceMinutes,
      })
    : { isLate: false, minutesAfterScheduledStart: 0 };
  const checkOutTime =
    input.checkOutServerTime === null
      ? null
      : input.checkOutServerTime instanceof Date
        ? input.checkOutServerTime
        : new Date(input.checkOutServerTime);
  if (checkOutTime && !Number.isFinite(checkOutTime.getTime())) {
    throw new RangeError('checkOutServerTime must be a valid instant.');
  }

  return {
    isLate: lateness.isLate,
    minutesAfterScheduledStart: lateness.minutesAfterScheduledStart,
    isEarlyLeave:
      checkOutTime !== null &&
      checkOutTime.getTime() < scheduledEnd.getTime() &&
      !input.hasApprovedLeave,
    missingCheckout: input.checkInServerTime !== null && input.checkOutServerTime === null,
  };
}
