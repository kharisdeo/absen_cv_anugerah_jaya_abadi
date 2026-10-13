import { describe, expect, it } from 'vitest';

import {
  currentJakartaMonth,
  formatReportCount,
  formatReportDate,
  formatReportInstant,
  formatReportMinutes,
  MONTHLY_REPORT_STATUS_LABELS,
} from '../src/pages/monthly-report-model.js';

describe('monthly report display model', () => {
  it('uses Asia/Jakarta to select the current report month at the UTC month boundary', () => {
    expect(currentJakartaMonth(new Date('2026-09-30T17:30:00.000Z'))).toBe('2026-10');
  });

  it('formats business dates in UTC date-only form and instants in WIB', () => {
    expect(formatReportDate('2026-10-12')).toContain('12');
    const formattedInstant = formatReportInstant('2026-10-12T17:30:00.000Z');
    expect(formattedInstant).toContain('13');
    expect(formattedInstant).toMatch(/00[.:]30/);
  });

  it('formats counts and durations and maps every backend status to an Indonesian label', () => {
    expect(formatReportCount(1200)).toBe('1.200');
    expect(formatReportMinutes(135)).toBe('2 jam 15 mnt');
    expect(formatReportMinutes(null)).toBe('—');
    expect(Object.keys(MONTHLY_REPORT_STATUS_LABELS)).toHaveLength(14);
  });
});
