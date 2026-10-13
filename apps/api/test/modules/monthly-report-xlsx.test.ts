import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { buildMonthlyReportWorkbook } from '../../src/modules/report/xlsx.js';
import { aggregateMonthlyReport } from '../../src/modules/report/index.js';
import type { MonthlyReportRepositoryRow } from '../../src/modules/report/index.js';

const require = createRequire(import.meta.url);

describe('monthly report XLSX', () => {
  it('round-trips two worksheets with summary parity, WIB times and literal untrusted text', async () => {
    const rows: MonthlyReportRepositoryRow[] = [
      {
        employeeId: '00000000-0000-4000-8000-000000000601',
        employeeName: '=HYPERLINK("https://example.invalid","unsafe")',
        shiftAssignmentId: '00000000-0000-4000-8000-000000000602',
        shiftId: '00000000-0000-4000-8000-000000000603',
        shiftName: 'Pagi',
        shiftBreakMinutes: 30,
        storeId: '00000000-0000-4000-8000-000000000604',
        storeName: 'Toko',
        date: '2026-10-01',
        isHoliday: false,
        status: 'PRESENT',
        checkInAt: new Date('2026-10-01T01:00:00.000Z'),
        checkOutAt: new Date('2026-10-01T10:00:00.000Z'),
        checkInValidationStatus: 'VALID',
        checkOutValidationStatus: 'APPROVED',
        hasPendingAttendance: false,
        hasLateCheckIn: false,
        pendingValidationStatus: null,
        hasRejectedAttendance: false,
        lateMinutesAfterScheduledStart: null,
        approvedOvertimeMinutes: 60,
      },
      {
        employeeId: '00000000-0000-4000-8000-000000000601',
        employeeName: '=HYPERLINK("https://example.invalid","unsafe")',
        shiftAssignmentId: '00000000-0000-4000-8000-000000000605',
        shiftId: '00000000-0000-4000-8000-000000000606',
        shiftName: 'Sore',
        shiftBreakMinutes: 0,
        storeId: '00000000-0000-4000-8000-000000000604',
        storeName: 'Toko',
        date: '2026-10-01',
        isHoliday: false,
        status: 'PRESENT',
        checkInAt: new Date('2026-10-01T11:00:00.000Z'),
        checkOutAt: new Date('2026-10-01T15:00:00.000Z'),
        checkInValidationStatus: 'VALID',
        checkOutValidationStatus: 'APPROVED',
        hasPendingAttendance: false,
        hasLateCheckIn: false,
        pendingValidationStatus: null,
        hasRejectedAttendance: false,
        lateMinutesAfterScheduledStart: null,
        approvedOvertimeMinutes: 0,
      },
    ];
    const report = aggregateMonthlyReport({
      month: '2026-10',
      filter: { month: '2026-10' },
      rows,
    });
    const bytes = await buildMonthlyReportWorkbook(report);
    const ExcelJS = require('exceljs') as {
      Workbook: new () => {
        xlsx: { load(data: Buffer): Promise<void> };
        worksheets: Array<{
          name: string;
          getCell(address: string): { value: unknown; formula?: unknown; numFmt?: string };
        }>;
      };
    };
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);

    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['Ringkasan', 'Detail Harian']);
    const summary = workbook.worksheets[0]!;
    const detail = workbook.worksheets[1]!;
    expect(summary.getCell('C2').value).toBe(1);
    expect(summary.getCell('L2').value).toBe(750);
    expect(detail.getCell('G2').value).toBe('Pagi');
    expect(detail.getCell('G3').value).toBe('Sore');
    expect(detail.getCell('J2').value).toBe(510);
    expect(detail.getCell('J3').value).toBe(240);
    expect(detail.getCell('K2').value).toBe('PRESENT');
    expect(detail.getCell('H2').value).toEqual(new Date('2026-10-01T08:00:00.000Z'));
    expect(detail.getCell('H3').value).toEqual(new Date('2026-10-01T18:00:00.000Z'));
    expect(detail.getCell('C2').value).toBe('=HYPERLINK("https://example.invalid","unsafe")');
    expect(detail.getCell('C2').formula).toBeUndefined();
    expect(detail.getCell('H2').numFmt).toBe('dd/mm/yyyy hh:mm');
    expect(detail.getCell('H3').numFmt).toBe('dd/mm/yyyy hh:mm');
  });
});
