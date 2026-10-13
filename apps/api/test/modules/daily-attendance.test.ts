import { describe, expect, it, vi } from 'vitest';

import {
  AttendanceValidationStatus,
  DailyAttendanceStatus,
} from '../../src/generated/prisma/enums.js';
import {
  DailyAttendanceService,
  absentCutoff,
  dailyStatusForAttendance,
  type DailyShiftInstance,
} from '../../src/modules/daily-attendance/index.js';

const workingDays = [1, 2, 3, 4, 5] as const;

function shift(overrides: Partial<DailyShiftInstance> = {}): DailyShiftInstance {
  return {
    employeeId: '00000000-0000-4000-8000-000000000021',
    shiftAssignmentId: '00000000-0000-4000-8000-000000000028',
    storeId: '00000000-0000-4000-8000-000000000026',
    workDate: '2026-10-09',
    startTime: '09:00:00',
    endTime: '18:00:00',
    workDays: workingDays,
    holidayDates: [],
    hasAmbiguousStoreHoliday: false,
    ...overrides,
  };
}

describe('DailyAttendanceService', () => {
  it('calculates the +2 hour cutoff in WIB for daytime and overnight shifts', () => {
    expect(absentCutoff(shift()).toISOString()).toBe('2026-10-09T13:00:00.000Z');
    expect(
      absentCutoff(
        shift({ workDate: '2026-10-10', startTime: '21:00:00', endTime: '05:00:00' }),
      ).toISOString(),
    ).toBe('2026-10-11T00:00:00.000Z');
  });

  it('evaluates only due shifts in the WIB work-date window and leaves nonworking/holiday dates alone', async () => {
    const shifts = [
      shift(),
      shift({ workDate: '2026-10-10' }),
      shift({ workDate: '2026-10-09', holidayDates: ['2026-10-09'] }),
      shift({ workDate: '2026-10-11' }),
      shift({ workDate: '2026-10-09', hasAmbiguousStoreHoliday: true }),
    ];
    const repository = {
      listShiftInstances: vi.fn(async () => shifts),
      markAbsentIfEligible: vi.fn(async () => 'created' as const),
      applyApprovedCorrection: vi.fn(async () => true),
    };

    const result = await new DailyAttendanceService(repository).runAbsentJob(
      new Date('2026-10-11T03:00:00.000Z'),
    );

    expect(repository.listShiftInstances).toHaveBeenCalledWith([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(repository.markAbsentIfEligible).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scanned: 5,
      notDue: 1,
      nonWorking: 2,
      ambiguousHoliday: 1,
      absentCreated: 1,
    });
  });

  it('reports repository race outcomes and remains safe to retry', async () => {
    const repository = {
      listShiftInstances: vi.fn(async () => [shift()]),
      markAbsentIfEligible: vi
        .fn()
        .mockResolvedValueOnce('created')
        .mockResolvedValueOnce('exists'),
      applyApprovedCorrection: vi.fn(async () => true),
    };
    const service = new DailyAttendanceService(repository);
    const now = new Date('2026-10-11T03:00:00.000Z');

    expect(await service.runAbsentJob(now)).toMatchObject({ absentCreated: 1 });
    expect(await service.runAbsentJob(now)).toMatchObject({ alreadyExists: 1 });
    expect(repository.markAbsentIfEligible).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      AttendanceValidationStatus.PENDING_VERIFICATION,
      false,
      DailyAttendanceStatus.WAITING_VERIFICATION,
    ],
    [AttendanceValidationStatus.PENDING_OFFLINE, false, DailyAttendanceStatus.WAITING_VERIFICATION],
    [AttendanceValidationStatus.VALID, false, DailyAttendanceStatus.PRESENT],
    [AttendanceValidationStatus.VALID, true, DailyAttendanceStatus.LATE],
    [AttendanceValidationStatus.APPROVED, false, DailyAttendanceStatus.PRESENT],
    [AttendanceValidationStatus.REJECTED, false, null],
  ] as const)('maps accepted attendance statuses to derived state', (status, late, expected) => {
    expect(dailyStatusForAttendance(status, late)).toBe(expected);
  });
});
