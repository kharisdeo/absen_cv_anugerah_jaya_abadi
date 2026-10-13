import { isHolidayDate, type HolidayDto } from '../api/admin-holidays-api.js';

export const CALENDAR_WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'] as const;

export function isCalendarMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  return isHolidayDate(`${value}-01`);
}

export function getCalendarCells(month: string): readonly (string | null)[] {
  if (!isCalendarMonth(month)) return [];
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const firstDay = new Date(`${month}-01T00:00:00.000Z`);
  const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = monthLengths[monthNumber - 1]!;
  return [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from(
      { length: daysInMonth },
      (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`,
    ),
  ];
}

export function formatHolidayDate(value: string): string {
  if (!isHolidayDate(value)) return value;
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function countHolidaysByDate(
  holidays: readonly HolidayDto[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const holiday of holidays)
    counts[holiday.holidayDate] = (counts[holiday.holidayDate] ?? 0) + 1;
  return counts;
}
