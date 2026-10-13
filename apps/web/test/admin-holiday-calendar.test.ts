import { describe, expect, it } from 'vitest';

import type { HolidayDto } from '../src/api/admin-holidays-api.js';
import {
  countHolidaysByDate,
  formatHolidayDate,
  getCalendarCells,
  isCalendarMonth,
} from '../src/pages/admin-holiday-calendar.js';

describe('admin holiday calendar helpers', () => {
  it('builds Monday-first cells and handles leap February without using local time', () => {
    expect(isCalendarMonth('2028-02')).toBe(true);
    expect(isCalendarMonth('2027-13')).toBe(false);
    const cells = getCalendarCells('2028-02');
    expect(cells).toHaveLength(29 + 1);
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBe('2028-02-01');
    expect(cells.at(-1)).toBe('2028-02-29');
  });

  it('does not fabricate a calendar for an empty or invalid month', () => {
    expect(getCalendarCells('')).toEqual([]);
    expect(getCalendarCells('2028-00')).toEqual([]);
  });

  it('counts server holidays by calendar date and formats their date in Indonesian', () => {
    const items: HolidayDto[] = [
      {
        id: '00000000-0000-4000-8000-000000000621',
        storeId: null,
        holidayDate: '2028-02-29',
        description: 'Nasional',
        createdAt: '2026-10-10T08:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000622',
        storeId: '00000000-0000-4000-8000-000000000623',
        holidayDate: '2028-02-29',
        description: 'Toko',
        createdAt: '2026-10-10T08:00:00.000Z',
      },
    ];

    expect(countHolidaysByDate(items)).toEqual({ '2028-02-29': 2 });
    expect(formatHolidayDate('2028-02-29')).toContain('2028');
  });
});
