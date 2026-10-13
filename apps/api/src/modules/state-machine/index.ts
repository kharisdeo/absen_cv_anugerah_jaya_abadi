import { AttendanceValidationStatus, RequestStatus } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';

type TransitionMap<TStatus extends string> = Partial<Record<TStatus, readonly TStatus[]>>;

const attendanceValidationTransitions = {
  [AttendanceValidationStatus.PENDING_OFFLINE]: [
    AttendanceValidationStatus.VALID,
    AttendanceValidationStatus.PENDING_VERIFICATION,
  ],
  [AttendanceValidationStatus.PENDING_VERIFICATION]: [
    AttendanceValidationStatus.APPROVED,
    AttendanceValidationStatus.REJECTED,
  ],
} satisfies TransitionMap<AttendanceValidationStatus>;

const requestStatusTransitions = {
  [RequestStatus.PENDING]: [
    RequestStatus.APPROVED,
    RequestStatus.REJECTED,
    RequestStatus.CANCELLED,
  ],
} satisfies TransitionMap<RequestStatus>;

function canTransition<TStatus extends string>(
  transitions: TransitionMap<TStatus>,
  from: TStatus,
  to: TStatus,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}

function assertTransition<TStatus extends string>(
  transitions: TransitionMap<TStatus>,
  from: TStatus,
  to: TStatus,
  errorCode: string,
  publicMessage: string,
): void {
  if (!canTransition(transitions, from, to)) {
    throw new AppError(409, errorCode, publicMessage);
  }
}

export function canTransitionAttendanceValidationStatus(
  from: AttendanceValidationStatus,
  to: AttendanceValidationStatus,
): boolean {
  return canTransition(attendanceValidationTransitions, from, to);
}

export function assertAttendanceValidationStatusTransition(
  from: AttendanceValidationStatus,
  to: AttendanceValidationStatus,
): void {
  assertTransition(
    attendanceValidationTransitions,
    from,
    to,
    'INVALID_ATTENDANCE_VALIDATION_TRANSITION',
    'Perubahan status validasi absensi tidak diizinkan.',
  );
}

export function canTransitionRequestStatus(from: RequestStatus, to: RequestStatus): boolean {
  return canTransition(requestStatusTransitions, from, to);
}

export function assertRequestStatusTransition(from: RequestStatus, to: RequestStatus): void {
  assertTransition(
    requestStatusTransitions,
    from,
    to,
    'INVALID_REQUEST_STATUS_TRANSITION',
    'Perubahan status pengajuan tidak diizinkan.',
  );
}
