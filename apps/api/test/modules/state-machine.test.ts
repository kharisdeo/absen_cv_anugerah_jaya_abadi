import { describe, expect, it } from 'vitest';

import {
  AttendanceValidationStatus,
  DailyAttendanceStatus,
  RequestStatus,
} from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  assertAttendanceValidationStatusTransition,
  assertRequestStatusTransition,
  canTransitionAttendanceValidationStatus,
  canTransitionRequestStatus,
} from '../../src/modules/state-machine/index.js';

const attendanceValidationStatuses = Object.values(AttendanceValidationStatus);
const requestStatuses = Object.values(RequestStatus);

const allowedAttendanceValidationTransitions = [
  [AttendanceValidationStatus.PENDING_OFFLINE, AttendanceValidationStatus.VALID],
  [AttendanceValidationStatus.PENDING_OFFLINE, AttendanceValidationStatus.PENDING_VERIFICATION],
  [AttendanceValidationStatus.PENDING_VERIFICATION, AttendanceValidationStatus.APPROVED],
  [AttendanceValidationStatus.PENDING_VERIFICATION, AttendanceValidationStatus.REJECTED],
] as const;

describe('attendance validation status state machine', () => {
  it('allows exactly the transitions specified by the requirements', () => {
    for (const from of attendanceValidationStatuses) {
      for (const to of attendanceValidationStatuses) {
        const expected = allowedAttendanceValidationTransitions.some(
          ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
        );

        expect(canTransitionAttendanceValidationStatus(from, to)).toBe(expected);
        if (expected) {
          expect(() => assertAttendanceValidationStatusTransition(from, to)).not.toThrow();
        }
      }
    }
  });

  it('rejects every transition not explicitly listed', () => {
    for (const from of attendanceValidationStatuses) {
      for (const to of attendanceValidationStatuses) {
        const isAllowed = allowedAttendanceValidationTransitions.some(
          ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
        );

        if (!isAllowed) {
          expect(canTransitionAttendanceValidationStatus(from, to)).toBe(false);
          expect(() => assertAttendanceValidationStatusTransition(from, to)).toThrow(
            expect.objectContaining({
              statusCode: 409,
              code: 'INVALID_ATTENDANCE_VALIDATION_TRANSITION',
            }),
          );
        }
      }
    }
  });

  it.each([
    AttendanceValidationStatus.VALID,
    AttendanceValidationStatus.APPROVED,
    AttendanceValidationStatus.REJECTED,
  ])('treats terminal attendance status %s as immutable', (terminalStatus) => {
    for (const target of attendanceValidationStatuses) {
      expect(canTransitionAttendanceValidationStatus(terminalStatus, target)).toBe(false);
      expect(() => assertAttendanceValidationStatusTransition(terminalStatus, target)).toThrow(
        AppError,
      );
    }
  });

  it('does not accept DailyAttendanceStatus.ABSENT as an attendance validation state', () => {
    const absentStatus = DailyAttendanceStatus.ABSENT as unknown as AttendanceValidationStatus;

    expect(
      canTransitionAttendanceValidationStatus(
        AttendanceValidationStatus.PENDING_OFFLINE,
        absentStatus,
      ),
    ).toBe(false);
    expect(
      canTransitionAttendanceValidationStatus(absentStatus, AttendanceValidationStatus.VALID),
    ).toBe(false);
    expect(() =>
      assertAttendanceValidationStatusTransition(
        AttendanceValidationStatus.PENDING_OFFLINE,
        absentStatus,
      ),
    ).toThrow(AppError);
  });
});

const allowedRequestStatusTransitions = [
  [RequestStatus.PENDING, RequestStatus.APPROVED],
  [RequestStatus.PENDING, RequestStatus.REJECTED],
  [RequestStatus.PENDING, RequestStatus.CANCELLED],
] as const;

describe('request status state machine', () => {
  it('allows exactly PENDING to APPROVED, REJECTED, or CANCELLED', () => {
    for (const from of requestStatuses) {
      for (const to of requestStatuses) {
        const expected = allowedRequestStatusTransitions.some(
          ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
        );

        expect(canTransitionRequestStatus(from, to)).toBe(expected);
        if (expected) {
          expect(() => assertRequestStatusTransition(from, to)).not.toThrow();
        }
      }
    }
  });

  it('rejects every request transition not explicitly listed', () => {
    for (const from of requestStatuses) {
      for (const to of requestStatuses) {
        const isAllowed = allowedRequestStatusTransitions.some(
          ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
        );

        if (!isAllowed) {
          expect(canTransitionRequestStatus(from, to)).toBe(false);
          expect(() => assertRequestStatusTransition(from, to)).toThrow(
            expect.objectContaining({
              statusCode: 409,
              code: 'INVALID_REQUEST_STATUS_TRANSITION',
            }),
          );
        }
      }
    }
  });

  it.each([RequestStatus.APPROVED, RequestStatus.REJECTED, RequestStatus.CANCELLED])(
    'treats terminal request status %s as immutable',
    (terminalStatus) => {
      for (const target of requestStatuses) {
        expect(canTransitionRequestStatus(terminalStatus, target)).toBe(false);
        expect(() => assertRequestStatusTransition(terminalStatus, target)).toThrow(AppError);
      }
    },
  );
});
