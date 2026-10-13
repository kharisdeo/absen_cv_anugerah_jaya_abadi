import { AttendanceValidationStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import { assertAttendanceValidationStatusTransition } from '../state-machine/index.js';
import type { SignedSelfieReadReceipt } from './selfie-upload.js';

const VERIFICATION_SLA_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

export type AttendanceVerificationActor = Readonly<{
  userAccountId: string;
  role: UserRole;
}>;

export type AttendanceVerificationHistoryItem = Readonly<{
  attendanceId: string;
  type: string;
  workDate: string;
  serverTime: string;
  deviceTime: string | null;
  validationStatus: string;
  reason: string | null;
  store: Readonly<{ id: string; name: string }> | null;
}>;

export type AttendanceVerificationRecord = Readonly<{
  attendanceId: string;
  employee: Readonly<{ id: string; fullName: string; position: string | null }>;
  store: Readonly<{ id: string; name: string }> | null;
  type: string;
  workDate: string;
  serverTime: Date;
  deviceTime: Date | null;
  validationStatus: AttendanceValidationStatus;
  method: string;
  networkStatus: string;
  sourceAttemptId: string | null;
  deviceName: string | null;
  location: Readonly<{
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    distanceMeters: number | null;
  }> | null;
}>;

export type AttendanceVerificationDecision = 'APPROVED' | 'REJECTED';

export type AttendanceVerificationDecisionReceipt = Readonly<{
  attendanceId: string;
  validationStatus: AttendanceVerificationDecision;
  reviewedAt: Date;
  serverTime: Date;
  deviceTime: Date | null;
}>;

export interface AttendanceVerificationRepository {
  listPending(
    input: Readonly<{
      actor: AttendanceVerificationActor;
      storeId?: string;
      skip: number;
      take: number;
    }>,
  ): Promise<Readonly<{ items: readonly AttendanceVerificationRecord[]; hasNextPage: boolean }>>;
  findPending(
    input: Readonly<{
      actor: AttendanceVerificationActor;
      attendanceId: string;
    }>,
  ): Promise<AttendanceVerificationRecord | null>;
  listHistory(
    input: Readonly<{
      actor: AttendanceVerificationActor;
      employeeId: string;
      before: Date;
      excludeAttendanceId: string;
      take: number;
    }>,
  ): Promise<readonly AttendanceVerificationHistoryItem[]>;
  decide(
    input: Readonly<{
      actor: AttendanceVerificationActor;
      attendanceId: string;
      decision: AttendanceVerificationDecision;
      reason: string | null;
      reviewedAt: Date;
      requestId: string;
    }>,
  ): Promise<AttendanceVerificationDecisionReceipt>;
}

export type AttendanceVerificationQueueItem = Readonly<{
  attendanceId: string;
  employee: AttendanceVerificationRecord['employee'];
  store: AttendanceVerificationRecord['store'];
  type: string;
  workDate: string;
  serverTime: string;
  deviceTime: string | null;
  dueAt: string;
  overdue: boolean;
  validationStatus: AttendanceValidationStatus;
  method: string;
  networkStatus: string;
  device: Readonly<{ name: string | null }>;
  location: AttendanceVerificationRecord['location'];
  selfie: SignedSelfieReadReceipt | null;
  recentAttendance: readonly AttendanceVerificationHistoryItem[];
}>;

export type AttendanceVerificationQueueQuery = Readonly<{
  page?: number;
  pageSize?: number;
  storeId?: string;
}>;

export type AttendanceVerificationQueuePage = Readonly<{
  items: readonly AttendanceVerificationQueueItem[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type AttendanceVerificationSelfieReader = Readonly<{
  createReviewReadUrl(
    principal: AuthPrincipal,
    attemptId: string,
  ): Promise<SignedSelfieReadReceipt>;
}>;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

function assertReviewer(actor: AttendanceVerificationActor): void {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.SUPERVISOR) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Hanya Admin atau Supervisor yang dapat memverifikasi absensi.',
    );
  }
}

function normalizePage(query: AttendanceVerificationQueueQuery) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new AppError(400, 'INVALID_VERIFICATION_QUERY', 'Nomor halaman tidak valid.');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new AppError(400, 'INVALID_VERIFICATION_QUERY', 'Ukuran halaman tidak valid.');
  }
  return { page, pageSize };
}

function normalizeReason(
  decision: AttendanceVerificationDecision,
  input: string | undefined,
): string | null {
  const reason = input?.trim() ?? '';
  if (decision === AttendanceValidationStatus.REJECTED && reason.length === 0) {
    throw new AppError(400, 'REJECTION_REASON_REQUIRED', 'Alasan penolakan wajib diisi.');
  }
  if (
    reason.length > 500 ||
    [...reason].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    throw new AppError(400, 'INVALID_VERIFICATION_REASON', 'Alasan verifikasi tidak valid.');
  }
  return reason.length === 0 ? null : reason;
}

function asActor(principal: AuthPrincipal): AttendanceVerificationActor {
  return { userAccountId: principal.userAccountId, role: principal.role };
}

export class AttendanceVerificationService {
  constructor(
    private readonly repository: AttendanceVerificationRepository,
    private readonly selfieReader: AttendanceVerificationSelfieReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listQueue(
    principal: AuthPrincipal,
    query: AttendanceVerificationQueueQuery = {},
  ): Promise<AttendanceVerificationQueuePage> {
    assertReviewer(principal);
    const { page, pageSize } = normalizePage(query);
    const result = await this.repository.listPending({
      actor: asActor(principal),
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
    });
    const now = this.now();
    const rows = result.items.slice(0, pageSize);
    const items = await Promise.all(rows.map((row) => this.toQueueItem(principal, row, now)));
    return {
      items,
      page,
      pageSize,
      hasNextPage: result.hasNextPage || result.items.length > pageSize,
    };
  }

  async getDetail(
    principal: AuthPrincipal,
    attendanceId: string,
  ): Promise<AttendanceVerificationQueueItem> {
    assertReviewer(principal);
    const row = await this.repository.findPending({ actor: asActor(principal), attendanceId });
    if (!row) throw notFound();
    return this.toQueueItem(principal, row, this.now());
  }

  async createSelfieReadUrl(
    principal: AuthPrincipal,
    attendanceId: string,
  ): Promise<SignedSelfieReadReceipt> {
    assertReviewer(principal);
    const row = await this.repository.findPending({ actor: asActor(principal), attendanceId });
    if (!row?.sourceAttemptId) throw notFound();
    return this.selfieReader.createReviewReadUrl(principal, row.sourceAttemptId);
  }

  async decide(
    principal: AuthPrincipal,
    attendanceId: string,
    input: Readonly<{ decision: AttendanceVerificationDecision; reason?: string }>,
    requestId: string,
  ): Promise<
    Readonly<{
      attendanceId: string;
      validationStatus: AttendanceVerificationDecision;
      reviewedAt: string;
      serverTime: string;
      deviceTime: string | null;
    }>
  > {
    assertReviewer(principal);
    const target = input.decision;
    assertAttendanceValidationStatusTransition(
      AttendanceValidationStatus.PENDING_VERIFICATION,
      target,
    );
    const reason = normalizeReason(target, input.reason);
    const result = await this.repository.decide({
      actor: asActor(principal),
      attendanceId,
      decision: target,
      reason,
      reviewedAt: this.now(),
      requestId,
    });
    return {
      attendanceId: result.attendanceId,
      validationStatus: result.validationStatus,
      reviewedAt: result.reviewedAt.toISOString(),
      serverTime: result.serverTime.toISOString(),
      deviceTime: result.deviceTime?.toISOString() ?? null,
    };
  }

  private async toQueueItem(
    principal: AuthPrincipal,
    row: AttendanceVerificationRecord,
    now: Date,
  ): Promise<AttendanceVerificationQueueItem> {
    const dueAt = new Date(row.serverTime.getTime() + VERIFICATION_SLA_MS);
    const [recentAttendance, selfie] = await Promise.all([
      this.repository.listHistory({
        actor: asActor(principal),
        employeeId: row.employee.id,
        before: row.serverTime,
        excludeAttendanceId: row.attendanceId,
        take: HISTORY_LIMIT,
      }),
      row.sourceAttemptId
        ? this.selfieReader
            .createReviewReadUrl(principal, row.sourceAttemptId)
            .catch((error: unknown) => {
              if (error instanceof AppError && error.statusCode === 404) return null;
              throw error;
            })
        : Promise.resolve(null),
    ]);
    return {
      attendanceId: row.attendanceId,
      employee: row.employee,
      store: row.store,
      type: row.type,
      workDate: row.workDate,
      serverTime: row.serverTime.toISOString(),
      deviceTime: row.deviceTime?.toISOString() ?? null,
      dueAt: dueAt.toISOString(),
      overdue: now.getTime() >= dueAt.getTime(),
      validationStatus: row.validationStatus,
      method: row.method,
      networkStatus: row.networkStatus,
      device: { name: row.deviceName },
      location: row.location,
      selfie,
      recentAttendance,
    };
  }
}

function notFound(): AppError {
  return new AppError(
    404,
    'ATTENDANCE_VERIFICATION_NOT_FOUND',
    'Data verifikasi absensi tidak ditemukan.',
  );
}
