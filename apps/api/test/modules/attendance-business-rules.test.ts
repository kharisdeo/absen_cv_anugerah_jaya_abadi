import { describe, expect, it } from 'vitest';

import {
  assertCheckoutFollowsCheckIn,
  assertNoValidCheckInDuplicate,
  assessAttendanceTiming,
} from '../../src/modules/attendance/business-rules.js';

const CHECKIN = {
  shiftAssignmentId: '00000000-0000-4000-8000-000000000001',
  workDate: '2026-10-11',
  serverTime: new Date('2026-10-11T02:00:00.000Z'),
  validationStatus: 'PENDING_VERIFICATION' as const,
  recordStatus: 'ACTIVE' as const,
};

describe('attendance business rules', () => {
  it('rejects a second valid check-in and points the employee to correction', () => {
    try {
      assertNoValidCheckInDuplicate(true);
      throw new Error('Expected duplicate check-in to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'ATTENDANCE_CHECK_IN_DUPLICATE',
      });
      expect(error).toHaveProperty('message', expect.stringContaining('koreksi'));
    }
  });

  it('does not create a checkout when the matching shift check-in is missing', () => {
    expect(() =>
      assertCheckoutFollowsCheckIn({
        checkIn: null,
        shiftAssignmentId: CHECKIN.shiftAssignmentId,
        workDate: CHECKIN.workDate,
        serverTime: new Date('2026-10-11T10:00:00.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'ATTENDANCE_CHECK_IN_REQUIRED' }));
  });

  it('rejects a check-in from another shift or work date', () => {
    expect(() =>
      assertCheckoutFollowsCheckIn({
        checkIn: CHECKIN,
        shiftAssignmentId: '00000000-0000-4000-8000-000000000002',
        workDate: CHECKIN.workDate,
        serverTime: new Date('2026-10-11T10:00:00.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'ATTENDANCE_CHECKOUT_SHIFT_MISMATCH' }));
    expect(() =>
      assertCheckoutFollowsCheckIn({
        checkIn: CHECKIN,
        shiftAssignmentId: CHECKIN.shiftAssignmentId,
        workDate: '2026-10-12',
        serverTime: new Date('2026-10-12T10:00:00.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'ATTENDANCE_CHECKOUT_SHIFT_MISMATCH' }));
  });

  it('requires server check-out time to be strictly after server check-in time', () => {
    expect(() =>
      assertCheckoutFollowsCheckIn({
        checkIn: CHECKIN,
        shiftAssignmentId: CHECKIN.shiftAssignmentId,
        workDate: CHECKIN.workDate,
        serverTime: CHECKIN.serverTime,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ATTENDANCE_CHECKOUT_OUT_OF_ORDER' }));
  });

  it('uses server time and shift tolerance for late status, not device time', () => {
    const onToleranceBoundary = assessAttendanceTiming({
      workDate: '2026-10-11',
      shiftStart: '09:00:00',
      shiftEnd: '18:00:00',
      toleranceMinutes: 10,
      checkInServerTime: '2026-10-11T02:10:00.000Z',
      checkOutServerTime: null,
      hasApprovedLeave: false,
    });
    const afterTolerance = assessAttendanceTiming({
      workDate: '2026-10-11',
      shiftStart: '09:00:00',
      shiftEnd: '18:00:00',
      toleranceMinutes: 10,
      checkInServerTime: '2026-10-11T02:11:00.000Z',
      checkOutServerTime: null,
      hasApprovedLeave: false,
    });

    expect(onToleranceBoundary.isLate).toBe(false);
    expect(afterTolerance).toMatchObject({
      isLate: true,
      minutesAfterScheduledStart: 11,
    });
  });

  it('flags early leave before scheduled end unless an approved leave covers the date', () => {
    const input = {
      workDate: '2026-10-11',
      shiftStart: '09:00:00',
      shiftEnd: '18:00:00',
      toleranceMinutes: 10,
      checkInServerTime: '2026-10-11T02:00:00.000Z',
      checkOutServerTime: '2026-10-11T10:59:00.000Z',
    };

    expect(assessAttendanceTiming({ ...input, hasApprovedLeave: false }).isEarlyLeave).toBe(true);
    expect(assessAttendanceTiming({ ...input, hasApprovedLeave: true }).isEarlyLeave).toBe(false);
  });

  it('compares early leave against the next WIB date for an overnight shift', () => {
    const overnightShift = {
      workDate: '2026-10-11',
      shiftStart: '21:00:00',
      shiftEnd: '05:00:00',
      toleranceMinutes: 0,
      checkInServerTime: '2026-10-11T14:00:00.000Z',
      hasApprovedLeave: false,
    };

    expect(
      assessAttendanceTiming({
        ...overnightShift,
        checkOutServerTime: '2026-10-11T21:59:59.999Z',
      }).isEarlyLeave,
    ).toBe(true);
    expect(
      assessAttendanceTiming({
        ...overnightShift,
        checkOutServerTime: '2026-10-11T22:00:00.000Z',
      }).isEarlyLeave,
    ).toBe(false);
  });

  it('reports missing checkout only when a check-in exists and checkout does not', () => {
    const base = {
      workDate: '2026-10-11',
      shiftStart: '09:00:00',
      shiftEnd: '18:00:00',
      toleranceMinutes: 0,
      hasApprovedLeave: false,
    };

    expect(
      assessAttendanceTiming({
        ...base,
        checkInServerTime: '2026-10-11T02:00:00.000Z',
        checkOutServerTime: null,
      }).missingCheckout,
    ).toBe(true);
    expect(
      assessAttendanceTiming({
        ...base,
        checkInServerTime: null,
        checkOutServerTime: null,
      }).missingCheckout,
    ).toBe(false);
  });
});
