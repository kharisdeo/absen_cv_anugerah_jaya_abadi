import { createRequire } from 'node:module';

import type { DailyReportDetail, MonthlyReportData } from './index.js';

type MutableExcelCell = {
  value: unknown;
  numFmt?: string;
  font?: unknown;
  fill?: unknown;
  alignment?: unknown;
};

type ExcelRow = Readonly<{ getCell(index: number): MutableExcelCell }>;

type ExcelWorksheet = {
  columns: readonly Readonly<{ header: string; key: string; width: number }>[];
  views: readonly Readonly<{ state: 'frozen'; ySplit: number }>[];
  autoFilter: string;
  addRow(values: readonly unknown[]): ExcelRow;
  getRow(rowNumber: number): ExcelRow;
};

type ExcelWorkbook = {
  creator: string;
  addWorksheet(name: string): ExcelWorksheet;
  xlsx: { writeBuffer(): Promise<Buffer | Uint8Array> };
};

type ExcelJsModule = { Workbook: new () => ExcelWorkbook };

const require = createRequire(import.meta.url);

function loadExcelJs(): ExcelJsModule {
  try {
    return require('exceljs') as ExcelJsModule;
  } catch {
    throw new Error(
      'Dependency runtime exceljs tidak tersedia. Jalankan instalasi dari pnpm-lock.yaml.',
    );
  }
}

function stringCell(value: string | null | undefined): string {
  // ExcelJS writes primitive strings as shared/inline strings, never as formula objects.
  return value ?? '';
}

function excelDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function excelWibDate(isoDateTime: string | null): Date | null {
  if (!isoDateTime) return null;
  const date = new Date(isoDateTime);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 7 * 60 * 60 * 1000);
}

function excelDuration(minutes: number): number {
  return minutes / (24 * 60);
}

function styleHeader(sheet: ExcelWorksheet, columnCount: number): void {
  const row = sheet.getRow(1);
  for (let index = 1; index <= columnCount; index += 1) {
    const cell = row.getCell(index);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
}

function styleDailyDateAndTimes(
  sheet: ExcelWorksheet,
  row: ExcelRow,
  detail: DailyReportDetail,
): void {
  row.getCell(1).value = excelDate(detail.date);
  row.getCell(1).numFmt = 'dd/mm/yyyy';
  row.getCell(8).value = excelWibDate(detail.checkInAt);
  row.getCell(8).numFmt = 'dd/mm/yyyy hh:mm';
  row.getCell(9).value = excelWibDate(detail.checkOutAt);
  row.getCell(9).numFmt = 'dd/mm/yyyy hh:mm';
}

/** Serialize the shared JSON aggregator contract; no formulas or report-specific queries. */
export async function buildMonthlyReportWorkbook(report: MonthlyReportData): Promise<Buffer> {
  const ExcelJS = loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Absensi CV Anugerah Jaya Abadi';

  const summary = workbook.addWorksheet('Ringkasan');
  const summaryColumns = [
    { header: 'ID Karyawan', key: 'employeeId', width: 38 },
    { header: 'Nama Karyawan', key: 'employeeName', width: 30 },
    { header: 'Hari Kerja (Tanggal Unik)', key: 'workDays', width: 26 },
    { header: 'Hadir', key: 'present', width: 12 },
    { header: 'Jumlah Terlambat', key: 'lateCount', width: 20 },
    { header: 'Menit Terlambat*', key: 'lateMinutes', width: 18 },
    { header: 'Tidak Hadir', key: 'absent', width: 15 },
    { header: 'Izin', key: 'leave', width: 12 },
    { header: 'Sakit', key: 'sick', width: 12 },
    { header: 'Cuti Tahunan', key: 'annualLeave', width: 16 },
    { header: 'Total Jam Kerja', key: 'totalWorkTime', width: 20 },
    { header: 'Total Menit Kerja', key: 'totalWorkMinutes', width: 20 },
    { header: 'Lembur Disetujui (Menit)', key: 'approvedOvertimeMinutes', width: 26 },
  ] as const;
  summary.columns = summaryColumns;
  summary.views = [{ state: 'frozen', ySplit: 1 }];
  summary.autoFilter = `A1:M${Math.max(1, report.summary.length + 1)}`;
  styleHeader(summary, summaryColumns.length);
  for (const row of report.summary) {
    const excelRow = summary.addRow([
      stringCell(row.employeeId),
      stringCell(row.employeeName),
      row.workDays,
      row.present,
      row.lateCount,
      row.lateMinutes,
      row.absent,
      row.leave,
      row.sick,
      row.annualLeave,
      excelDuration(row.totalWorkMinutes),
      row.totalWorkMinutes,
      row.approvedOvertimeMinutes,
    ]);
    excelRow.getCell(11).numFmt = '[h]:mm';
  }

  const details = workbook.addWorksheet('Detail Harian');
  const detailColumns = [
    { header: 'Tanggal', key: 'date', width: 14 },
    { header: 'ID Karyawan', key: 'employeeId', width: 38 },
    { header: 'Nama Karyawan', key: 'employeeName', width: 30 },
    { header: 'ID Toko', key: 'storeId', width: 38 },
    { header: 'Toko', key: 'storeName', width: 24 },
    { header: 'ID Assignment Shift', key: 'shiftAssignmentId', width: 38 },
    { header: 'Shift', key: 'shiftName', width: 22 },
    { header: 'Masuk (WIB)', key: 'checkInAt', width: 22 },
    { header: 'Pulang (WIB)', key: 'checkOutAt', width: 22 },
    { header: 'Durasi Kerja (Menit)', key: 'durationMinutes', width: 22 },
    { header: 'Status Harian', key: 'status', width: 24 },
    {
      header: 'Menit sejak mulai jadwal jika terlambat',
      key: 'lateMinutesAfterScheduledStart',
      width: 36,
    },
    { header: 'Validasi Masuk', key: 'checkInValidationStatus', width: 26 },
    { header: 'Validasi Pulang', key: 'checkOutValidationStatus', width: 26 },
    { header: 'Validasi Keseluruhan', key: 'validationStatus', width: 26 },
  ] as const;
  details.columns = detailColumns;
  details.views = [{ state: 'frozen', ySplit: 1 }];
  details.autoFilter = `A1:O${Math.max(1, report.dailyDetails.length + 1)}`;
  styleHeader(details, detailColumns.length);
  for (const detail of report.dailyDetails) {
    const excelRow = details.addRow([
      excelDate(detail.date),
      stringCell(detail.employeeId),
      stringCell(detail.employeeName),
      stringCell(detail.store?.id),
      stringCell(detail.store?.name),
      stringCell(detail.shift.assignmentId),
      stringCell(detail.shift.name),
      excelWibDate(detail.checkInAt),
      excelWibDate(detail.checkOutAt),
      detail.durationMinutes,
      stringCell(detail.status),
      detail.lateMinutesAfterScheduledStart,
      stringCell(detail.checkInValidationStatus),
      stringCell(detail.checkOutValidationStatus),
      stringCell(detail.validationStatus),
    ]);
    styleDailyDateAndTimes(details, excelRow, detail);
  }

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
