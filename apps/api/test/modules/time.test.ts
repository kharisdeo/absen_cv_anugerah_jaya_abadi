import { afterEach, describe, expect, it } from 'vitest';

import {
  addWorkingDays,
  BUSINESS_TIME_ZONE,
  calculateCheckInLateness,
  getBusinessDateAndWeekday,
  isWorkingDay,
  resolveShiftEnd,
} from '../../src/modules/time/index.js';

const originalTimezone = process.env.TZ;

afterEach(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

describe('business date and weekday', () => {
  it('uses Asia/Jakarta by default and rolls over date, month, and year from an offset instant', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Jakarta');
    expect(getBusinessDateAndWeekday('2026-01-01T17:05:00Z')).toEqual({
      businessDate: '2026-01-02',
      weekday: 5,
    });
    expect(getBusinessDateAndWeekday('2025-12-31T17:30:00Z')).toEqual({
      businessDate: '2026-01-01',
      weekday: 4,
    });
  });

  it('returns the same WIB date around a DST change under different host timezones', () => {
    const instants = ['2026-03-08T07:30:00Z', '2026-03-08T10:30:00Z'];
    const results: ReturnType<typeof getBusinessDateAndWeekday>[][] = [];

    for (const timezone of ['UTC', 'America/Los_Angeles', 'America/New_York']) {
      process.env.TZ = timezone;
      results.push(instants.map((instant) => getBusinessDateAndWeekday(instant)));
    }

    expect(results[0]).toEqual([
      { businessDate: '2026-03-08', weekday: 7 },
      { businessDate: '2026-03-08', weekday: 7 },
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('requires ISO strings to include a valid explicit offset', () => {
    expect(() => getBusinessDateAndWeekday('2026-01-01T10:00:00')).toThrow(RangeError);
    expect(() => getBusinessDateAndWeekday('2026-02-30T10:00:00+07:00')).toThrow(RangeError);
    expect(() => getBusinessDateAndWeekday('2026-01-01T10:00:00+07:99')).toThrow(RangeError);
  });
});

describe('working days', () => {
  it('uses the supplied shift weekdays instead of assuming Monday through Friday', () => {
    const workDays = [2, 4, 6] as const;
    expect(isWorkingDay('2026-01-07', workDays)).toBe(false); // Wednesday
    expect(isWorkingDay('2026-01-08', workDays)).toBe(true); // Thursday
    expect(addWorkingDays('2026-01-07', 3, workDays)).toBe('2026-01-13');
  });

  it('skips supplied national and store holidays and crosses month/year boundaries', () => {
    const holidays = ['2025-12-29', '2026-01-01'];
    expect(addWorkingDays('2025-12-26', 3, [1, 2, 3, 4, 5], holidays)).toBe('2026-01-02');
    expect(isWorkingDay('2026-01-01', [1, 2, 3, 4, 5], holidays)).toBe(false);
  });

  it('returns the start date for H+0 and rejects invalid dates, schedules, and counts', () => {
    expect(addWorkingDays('2026-01-04', 0, [1, 3, 5])).toBe('2026-01-04');
    expect(() => addWorkingDays('2026-02-30', 1, [1])).toThrow(RangeError);
    expect(() => addWorkingDays('2026-01-01', 1, [0])).toThrow(RangeError);
    expect(() => addWorkingDays('2026-01-01', 1, [])).toThrow(RangeError);
    expect(() => addWorkingDays('2026-01-01', -1, [1])).toThrow(RangeError);
  });
});

describe('check-in lateness', () => {
  it('uses a caller-selected tolerance with a strict greater-than boundary', () => {
    const scheduledStart = '2026-01-10T09:00:00+07:00';
    expect(
      calculateCheckInLateness({
        scheduledStart,
        actualServerTime: '2026-01-10T09:05:00+07:00',
        toleranceMinutes: 5,
      }),
    ).toEqual({ isLate: false, minutesAfterScheduledStart: 5 });
    const justLate = calculateCheckInLateness({
      scheduledStart,
      actualServerTime: '2026-01-10T02:05:00.001Z',
      toleranceMinutes: 5,
    });
    expect(justLate.isLate).toBe(true);
    expect(justLate.minutesAfterScheduledStart).toBeCloseTo(5.000016666666667);
  });

  it('does not count an early check-in as late or as positive elapsed minutes', () => {
    expect(
      calculateCheckInLateness({
        scheduledStart: new Date('2026-01-10T02:00:00Z'),
        actualServerTime: new Date('2026-01-10T01:59:00Z'),
        toleranceMinutes: 0,
      }),
    ).toEqual({ isLate: false, minutesAfterScheduledStart: 0 });
  });

  it('rejects invalid timestamps and tolerance values', () => {
    expect(() =>
      calculateCheckInLateness({
        scheduledStart: '2026-01-10T09:00:00',
        actualServerTime: '2026-01-10T09:01:00+07:00',
        toleranceMinutes: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateCheckInLateness({
        scheduledStart: '2026-01-10T09:00:00+07:00',
        actualServerTime: '2026-01-10T09:01:00+07:00',
        toleranceMinutes: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe('overnight shift end', () => {
  it('keeps same-day shifts on the same date and rolls overnight shifts to the next date', () => {
    expect(resolveShiftEnd('2026-03-31', '09:00', '17:00')).toEqual({
      businessDate: '2026-03-31',
      clockTime: '17:00',
    });
    expect(resolveShiftEnd('2025-12-31', '22:00', '06:30:00')).toEqual({
      businessDate: '2026-01-01',
      clockTime: '06:30:00',
    });
  });

  it('rejects equal start/end times and invalid dates or clock times', () => {
    expect(() => resolveShiftEnd('2026-01-01', '09:00', '09:00:00')).toThrow(RangeError);
    expect(() => resolveShiftEnd('2026-02-30', '22:00', '06:00')).toThrow(RangeError);
    expect(() => resolveShiftEnd('2026-01-01', '24:00', '06:00')).toThrow(RangeError);
    expect(() => resolveShiftEnd('2026-01-01', '22:00', '06:60')).toThrow(RangeError);
  });
});
