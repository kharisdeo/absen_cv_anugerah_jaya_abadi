export const BUSINESS_TIME_ZONE = 'Asia/Jakarta';

export type BusinessDate = string;
export type ClockTime = string;
export type Instant = Date | string;

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface BusinessDateAndWeekday {
  businessDate: BusinessDate;
  weekday: IsoWeekday;
}

export interface CheckInLatenessInput {
  scheduledStart: Instant;
  actualServerTime: Instant;
  toleranceMinutes: number;
}

export interface CheckInLateness {
  isLate: boolean;
  /** Exact non-negative elapsed minutes from scheduled start, independent of tolerance. */
  minutesAfterScheduledStart: number;
}

export interface ResolvedShiftEnd {
  businessDate: BusinessDate;
  clockTime: ClockTime;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const ISO_WEEKDAYS = new Set<number>([1, 2, 3, 4, 5, 6, 7]);

function parseBusinessDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Invalid business date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid business date: ${value}`);
  }

  return { year, month, day };
}

/** Validates a calendar date in YYYY-MM-DD form without interpreting it as an instant. */
export function assertBusinessDate(value: string): BusinessDate {
  parseBusinessDate(value);
  return value;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCDate();
}

function formatBusinessDate(year: number, month: number, day: number): BusinessDate {
  if (year < 1 || year > 9999) {
    throw new RangeError('Business date is outside the supported year range 0001-9999.');
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nextBusinessDate(value: BusinessDate): BusinessDate {
  const { year, month, day } = parseBusinessDate(value);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + 1);
  date.setUTCHours(0, 0, 0, 0);

  return formatBusinessDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getIsoWeekday(value: BusinessDate): IsoWeekday {
  const { year, month, day } = parseBusinessDate(value);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);

  const weekday = date.getUTCDay();
  return (weekday === 0 ? 7 : weekday) as IsoWeekday;
}

function parseInstant(value: Instant, fieldName: string): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    throw new RangeError(`${fieldName} must be a valid Date.`);
  }

  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`${fieldName} must be an ISO timestamp with an explicit UTC offset.`);
  }

  parseBusinessDate(match[1]!);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  const offset = match[6]!;
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new RangeError(`${fieldName} contains an invalid time or UTC offset.`);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`${fieldName} must be a valid ISO timestamp.`);
  }
  return timestamp;
}

function assertIsoWeekdays(workDays: readonly number[]): void {
  if (!Array.isArray(workDays) || workDays.some((day) => !ISO_WEEKDAYS.has(day))) {
    throw new RangeError('workDays must contain ISO weekdays from 1 (Monday) through 7 (Sunday).');
  }
}

function assertClockTime(value: string, fieldName: string): number {
  const match = CLOCK_TIME_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`${fieldName} must use HH:mm or HH:mm:ss format.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`${fieldName} is outside the valid clock-time range.`);
  }

  return hour * 3_600 + minute * 60 + second;
}

/** Validates a wall-clock value without assigning it a timezone or changing its spelling. */
export function assertValidClockTime(value: string): ClockTime {
  assertClockTime(value, 'clockTime');
  return value;
}

/**
 * Converts an instant to the business calendar using an explicit IANA timezone.
 * ISO strings must include Z or a numeric UTC offset; Date values already represent instants.
 */
export function getBusinessDateAndWeekday(
  instant: Instant,
  timeZone: string = BUSINESS_TIME_ZONE,
): BusinessDateAndWeekday {
  const timestamp = parseInstant(instant, 'instant');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      calendar: 'iso8601',
      numberingSystem: 'latn',
    });
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${timeZone}`);
  }

  const parts = formatter.formatToParts(timestamp);
  const partValues = new Map(parts.map(({ type, value }) => [type, value]));
  const year = partValues.get('year');
  const month = partValues.get('month');
  const day = partValues.get('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Intl.DateTimeFormat did not return a complete business date.');
  }

  const businessDate = formatBusinessDate(Number(year), Number(month), Number(day));
  return { businessDate, weekday: getIsoWeekday(businessDate) };
}

/** Workdays are supplied by the assigned shift; holidays are excluded regardless of weekday. */
export function isWorkingDay(
  businessDate: BusinessDate,
  workDays: readonly number[],
  holidays: readonly BusinessDate[] = [],
): boolean {
  parseBusinessDate(businessDate);
  assertIsoWeekdays(workDays);
  const holidayDates = new Set(holidays);
  for (const holiday of holidayDates) parseBusinessDate(holiday);

  return workDays.includes(getIsoWeekday(businessDate)) && !holidayDates.has(businessDate);
}

/** Adds N scheduled workdays after the start date, skipping supplied national/store holidays. */
export function addWorkingDays(
  startDate: BusinessDate,
  daysToAdd: number,
  workDays: readonly number[],
  holidays: readonly BusinessDate[] = [],
): BusinessDate {
  parseBusinessDate(startDate);
  assertIsoWeekdays(workDays);
  if (!Number.isSafeInteger(daysToAdd) || daysToAdd < 0) {
    throw new RangeError('daysToAdd must be a non-negative safe integer.');
  }
  const holidayDates = new Set(holidays);
  for (const holiday of holidayDates) parseBusinessDate(holiday);
  if (daysToAdd > 0 && workDays.length === 0) {
    throw new RangeError('Cannot add working days when the supplied schedule has no workdays.');
  }

  let result = startDate;
  let added = 0;
  while (added < daysToAdd) {
    result = nextBusinessDate(result);
    if (workDays.includes(getIsoWeekday(result)) && !holidayDates.has(result)) added += 1;
  }
  return result;
}

/**
 * A check-in is late only when actual server time is strictly after scheduled start + tolerance.
 * The returned elapsed minutes are measured from scheduled start (not from the grace boundary).
 */
export function calculateCheckInLateness(input: CheckInLatenessInput): CheckInLateness {
  const scheduledStart = parseInstant(input.scheduledStart, 'scheduledStart');
  const actualServerTime = parseInstant(input.actualServerTime, 'actualServerTime');
  if (!Number.isSafeInteger(input.toleranceMinutes) || input.toleranceMinutes < 0) {
    throw new RangeError('toleranceMinutes must be a non-negative safe integer.');
  }

  return {
    isLate: actualServerTime > scheduledStart + input.toleranceMinutes * 60_000,
    minutesAfterScheduledStart: Math.max(0, actualServerTime - scheduledStart) / 60_000,
  };
}

/** Resolves the local calendar date of a shift end; equal clock times are not treated as 24 hours. */
export function resolveShiftEnd(
  businessDate: BusinessDate,
  startTime: ClockTime,
  endTime: ClockTime,
): ResolvedShiftEnd {
  parseBusinessDate(businessDate);
  const startSeconds = assertClockTime(startTime, 'startTime');
  const endSeconds = assertClockTime(endTime, 'endTime');
  if (startSeconds === endSeconds) {
    throw new RangeError('Shift start and end times must differ; 24-hour shifts are not inferred.');
  }

  return {
    businessDate: endSeconds < startSeconds ? nextBusinessDate(businessDate) : businessDate,
    clockTime: endTime,
  };
}
