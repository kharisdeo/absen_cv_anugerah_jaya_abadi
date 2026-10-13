import { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import {
  BUSINESS_TIME_ZONE,
  assertBusinessDate,
  getBusinessDateAndWeekday,
} from '../time/index.js';

export type DashboardActor = Readonly<{ userAccountId: string; role: UserRole }>;

export type DashboardFilter = Readonly<{
  date?: string;
  storeId?: string;
  shiftId?: string;
  page?: number;
  pageSize?: number;
}>;

export type DashboardStatus =
  | 'PRESENT'
  | 'LATE'
  | 'NOT_CHECKED_IN'
  | 'ABSENT'
  | 'LEAVE'
  | 'SICK'
  | 'ANNUAL_LEAVE'
  | 'WAITING_VERIFICATION'
  | 'REQUEST_PENDING'
  | 'HOLIDAY'
  | 'EARLY_LEAVE'
  | 'MISSING_CHECKOUT'
  | 'UNATTRIBUTED_ATTENDANCE';

export type DashboardShiftItem = Readonly<{
  employeeId: string;
  employeeName: string;
  shiftAssignmentId: string;
  shiftId: string;
  shiftName: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  store: Readonly<{ id: string; name: string }> | null;
  date: string;
  status: DashboardStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  minutesAfterScheduledStart: number | null;
}>;

export type DashboardSummary = Readonly<{
  scheduledShifts: number;
  present: number;
  late: number;
  notCheckedIn: number;
  absent: number;
  leave: number;
  sick: number;
  annualLeave: number;
  waitingVerification: number;
  pendingRequests: number;
}>;

export type DashboardTrendItem = DashboardSummary & Readonly<{ date: string }>;

export type DashboardLateRankingItem = Readonly<{
  employeeId: string;
  employeeName: string;
  lateCount: number;
  lateDays: number;
  totalMinutesAfterScheduledStart: number;
}>;

export type DashboardData = Readonly<{
  summary: DashboardSummary;
  notCheckedIn: Readonly<{
    items: readonly DashboardShiftItem[];
    page: number;
    pageSize: number;
    hasNextPage: boolean;
  }>;
  trend: readonly DashboardTrendItem[];
  lateRanking: readonly DashboardLateRankingItem[];
}>;

export type EmployeeHistoryItem = Readonly<{
  id: string;
  date: string;
  type: 'CHECK_IN' | 'CHECK_OUT';
  serverTime: string;
  validationStatus: string;
  store: Readonly<{ id: string; name: string }> | null;
  shift: Readonly<{ id: string; name: string }> | null;
}>;

export type EmployeeRequestStatusItem = Readonly<{
  id: string;
  requestType: string;
  startDate: string;
  endDate: string;
  status: string;
  requestedAt: string;
  decisionAt: string | null;
}>;

export interface DashboardRepository {
  adminDashboard(
    input: Readonly<{
      actor: DashboardActor;
      filter: DashboardFilter & { date: string; page: number; pageSize: number };
      today: string;
    }>,
  ): Promise<DashboardData>;
  employeeDashboard(
    input: Readonly<{
      userAccountId: string;
      employeeId: string;
      date: string;
      historyPage: number;
      historyPageSize: number;
      historyFrom?: string;
      historyTo?: string;
      requestPage: number;
      requestPageSize: number;
    }>,
  ): Promise<
    Readonly<{
      today: readonly DashboardShiftItem[];
      history: Readonly<{
        items: readonly EmployeeHistoryItem[];
        page: number;
        pageSize: number;
        hasNextPage: boolean;
      }>;
      requests: Readonly<{
        items: readonly EmployeeRequestStatusItem[];
        page: number;
        pageSize: number;
        hasNextPage: boolean;
      }>;
    }>
  >;
}

function invalidInput(message: string): AppError {
  return new AppError(400, 'INVALID_DASHBOARD_INPUT', message);
}

function normalizeUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return value;
}

function normalizePage(value: number | undefined, fallback: number, label: string): number {
  const page = value ?? fallback;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw invalidInput(`${label} tidak valid.`);
  }
  return page;
}

function normalizePageSize(value: number | undefined, fallback: number, label: string): number {
  const pageSize = value ?? fallback;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw invalidInput(`${label} harus 1 sampai 50.`);
  }
  return pageSize;
}

function actorOf(principal: AuthPrincipal): DashboardActor {
  return { userAccountId: principal.userAccountId, role: principal.role };
}

export class DashboardService {
  constructor(
    private readonly repository: DashboardRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = BUSINESS_TIME_ZONE,
  ) {}

  async adminDashboard(principal: AuthPrincipal, filter: DashboardFilter = {}) {
    if (principal.role !== UserRole.ADMIN && principal.role !== UserRole.SUPERVISOR) {
      throw new AppError(403, 'FORBIDDEN', 'Dashboard hanya tersedia untuk Admin dan Supervisor.');
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new AppError(503, 'INTERNAL_SERVER_ERROR', 'Waktu server tidak tersedia.');
    }
    const today = getBusinessDateAndWeekday(now, this.timeZone).businessDate;
    let date: string;
    try {
      date =
        filter.date === undefined
          ? getBusinessDateAndWeekday(now, this.timeZone).businessDate
          : assertBusinessDate(filter.date);
    } catch {
      throw invalidInput('Tanggal harus berupa tanggal kalender YYYY-MM-DD yang valid.');
    }
    if (date > today) {
      throw invalidInput('Tanggal dashboard tidak boleh setelah tanggal bisnis server.');
    }
    const normalized: DashboardFilter & { date: string; page: number; pageSize: number } = {
      date,
      page: normalizePage(filter.page, 1, 'Halaman daftar belum check-in'),
      pageSize: normalizePageSize(filter.pageSize, 25, 'Ukuran halaman daftar belum check-in'),
      ...(filter.storeId === undefined
        ? {}
        : { storeId: normalizeUuid(filter.storeId, 'storeId') }),
      ...(filter.shiftId === undefined
        ? {}
        : { shiftId: normalizeUuid(filter.shiftId, 'shiftId') }),
    };
    return this.repository.adminDashboard({ actor: actorOf(principal), filter: normalized, today });
  }

  async employeeDashboard(
    principal: AuthPrincipal,
    filter: Readonly<{
      historyPage?: number;
      historyPageSize?: number;
      historyFrom?: string;
      historyTo?: string;
      requestPage?: number;
      requestPageSize?: number;
    }> = {},
  ) {
    if (principal.role !== UserRole.EMPLOYEE || !principal.employeeId) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Status dan riwayat hanya tersedia untuk karyawan terkait.',
      );
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new AppError(503, 'INTERNAL_SERVER_ERROR', 'Waktu server tidak tersedia.');
    }
    const date = getBusinessDateAndWeekday(now, this.timeZone).businessDate;
    let historyFrom: string | undefined;
    let historyTo: string | undefined;
    try {
      historyFrom =
        filter.historyFrom === undefined ? undefined : assertBusinessDate(filter.historyFrom);
      historyTo = filter.historyTo === undefined ? undefined : assertBusinessDate(filter.historyTo);
    } catch {
      throw invalidInput(
        'Rentang riwayat harus menggunakan tanggal kalender YYYY-MM-DD yang valid.',
      );
    }
    if (historyFrom !== undefined && historyTo !== undefined && historyFrom > historyTo) {
      throw invalidInput('Tanggal awal riwayat tidak boleh setelah tanggal akhir.');
    }
    return this.repository.employeeDashboard({
      userAccountId: principal.userAccountId,
      employeeId: normalizeUuid(principal.employeeId, 'Profil karyawan'),
      date,
      historyPage: normalizePage(filter.historyPage, 1, 'Halaman riwayat absensi'),
      historyPageSize: normalizePageSize(filter.historyPageSize, 20, 'Ukuran halaman riwayat'),
      ...(historyFrom === undefined ? {} : { historyFrom }),
      ...(historyTo === undefined ? {} : { historyTo }),
      requestPage: normalizePage(filter.requestPage, 1, 'Halaman status pengajuan'),
      requestPageSize: normalizePageSize(filter.requestPageSize, 20, 'Ukuran halaman pengajuan'),
    });
  }
}
