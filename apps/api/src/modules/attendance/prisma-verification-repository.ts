import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  AttendanceVerificationActor,
  AttendanceVerificationDecision,
  AttendanceVerificationDecisionReceipt,
  AttendanceVerificationHistoryItem,
  AttendanceVerificationRecord,
  AttendanceVerificationRepository,
} from './verification-workflow.js';

const reviewSelect = {
  id: true,
  employeeId: true,
  storeId: true,
  type: true,
  workDate: true,
  serverTime: true,
  deviceTime: true,
  validationStatus: true,
  method: true,
  networkStatus: true,
  sourceAttemptId: true,
  employee: { select: { id: true, fullName: true, position: true } },
  store: { select: { id: true, name: true } },
  sourceAttempt: {
    select: { deviceBinding: { select: { deviceName: true } } },
  },
  locationProof: {
    select: { latitude: true, longitude: true, accuracyMeters: true, distanceMeters: true },
  },
} as const;

const historySelect = {
  id: true,
  type: true,
  workDate: true,
  serverTime: true,
  deviceTime: true,
  validationStatus: true,
  validationReason: true,
  store: { select: { id: true, name: true } },
} as const;

const decisionSelect = {
  id: true,
  type: true,
  serverTime: true,
  deviceTime: true,
  validationStatus: true,
  employee: { select: { accountId: true } },
} as const;

type ReviewRow = Prisma.AttendanceGetPayload<{ select: typeof reviewSelect }>;
type HistoryRow = Prisma.AttendanceGetPayload<{ select: typeof historySelect }>;
function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function mapReview(row: ReviewRow): AttendanceVerificationRecord {
  return {
    attendanceId: row.id,
    employee: row.employee,
    store: row.store,
    type: row.type,
    workDate: dateOnly(row.workDate),
    serverTime: row.serverTime,
    deviceTime: row.deviceTime,
    validationStatus: row.validationStatus,
    method: row.method,
    networkStatus: row.networkStatus,
    sourceAttemptId: row.sourceAttemptId,
    deviceName: row.sourceAttempt?.deviceBinding.deviceName ?? null,
    location: row.locationProof
      ? {
          latitude: Number(row.locationProof.latitude),
          longitude: Number(row.locationProof.longitude),
          accuracyMeters: Number(row.locationProof.accuracyMeters),
          distanceMeters:
            row.locationProof.distanceMeters === null
              ? null
              : Number(row.locationProof.distanceMeters),
        }
      : null,
  };
}

function mapHistory(row: HistoryRow): AttendanceVerificationHistoryItem {
  return {
    attendanceId: row.id,
    type: row.type,
    workDate: dateOnly(row.workDate),
    serverTime: row.serverTime.toISOString(),
    deviceTime: row.deviceTime?.toISOString() ?? null,
    validationStatus: row.validationStatus,
    reason: row.validationReason,
    store: row.store,
  };
}

function scopeWhere(actor: AttendanceVerificationActor): Prisma.AttendanceWhereInput {
  if (actor.role !== 'SUPERVISOR') return {};
  return {
    store: {
      is: {
        supervisorAssignments: { some: { supervisorUserAccountId: actor.userAccountId } },
      },
    },
  };
}

function notFound(): AppError {
  return new AppError(
    404,
    'ATTENDANCE_VERIFICATION_NOT_FOUND',
    'Data verifikasi absensi tidak ditemukan.',
  );
}

function decisionConflict(): AppError {
  return new AppError(
    409,
    'ATTENDANCE_VERIFICATION_CONFLICT',
    'Absensi ini sudah diputuskan atau tidak lagi menunggu verifikasi.',
  );
}

export class PrismaAttendanceVerificationRepository implements AttendanceVerificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listPending(input: {
    actor: AttendanceVerificationActor;
    storeId?: string;
    skip: number;
    take: number;
  }) {
    const rows = await this.prisma.attendance.findMany({
      where: {
        AND: [
          { validationStatus: 'PENDING_VERIFICATION', recordStatus: 'ACTIVE' },
          scopeWhere(input.actor),
          ...(input.storeId === undefined ? [] : [{ storeId: input.storeId }]),
        ],
      },
      orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
      skip: input.skip,
      take: input.take,
      select: reviewSelect,
    });
    return { items: rows.map(mapReview), hasNextPage: false };
  }

  async findPending(input: { actor: AttendanceVerificationActor; attendanceId: string }) {
    const row = await this.prisma.attendance.findFirst({
      where: {
        id: input.attendanceId,
        validationStatus: 'PENDING_VERIFICATION',
        recordStatus: 'ACTIVE',
        ...scopeWhere(input.actor),
      },
      select: reviewSelect,
    });
    return row ? mapReview(row) : null;
  }

  async listHistory(input: {
    actor: AttendanceVerificationActor;
    employeeId: string;
    before: Date;
    excludeAttendanceId: string;
    take: number;
  }) {
    const rows = await this.prisma.attendance.findMany({
      where: {
        employeeId: input.employeeId,
        id: { not: input.excludeAttendanceId },
        recordStatus: 'ACTIVE',
        serverTime: { lt: input.before },
        ...scopeWhere(input.actor),
      },
      orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
      take: input.take,
      select: historySelect,
    });
    return rows.map(mapHistory);
  }

  async decide(input: {
    actor: AttendanceVerificationActor;
    attendanceId: string;
    decision: AttendanceVerificationDecision;
    reason: string | null;
    reviewedAt: Date;
    requestId: string;
  }): Promise<AttendanceVerificationDecisionReceipt> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const row = await transaction.attendance.findFirst({
            where: {
              id: input.attendanceId,
              recordStatus: 'ACTIVE',
              ...scopeWhere(input.actor),
            },
            select: decisionSelect,
          });
          if (!row) throw notFound();
          if (row.validationStatus !== 'PENDING_VERIFICATION') throw decisionConflict();

          const transition = await transaction.attendance.updateMany({
            where: {
              id: row.id,
              recordStatus: 'ACTIVE',
              validationStatus: 'PENDING_VERIFICATION',
              ...scopeWhere(input.actor),
            },
            data: {
              validationStatus: input.decision,
              validationReviewedByUserAccountId: input.actor.userAccountId,
              validationReviewedAt: input.reviewedAt,
              validationReason: input.reason,
            },
          });
          if (transition.count !== 1) throw decisionConflict();

          const decisionText = input.decision === 'APPROVED' ? 'disetujui' : 'ditolak';
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: input.actor.userAccountId,
              action:
                input.decision === 'APPROVED'
                  ? 'attendance.verification.approve'
                  : 'attendance.verification.reject',
              entityType: 'attendance',
              entityId: row.id,
              beforeData: { validationStatus: 'PENDING_VERIFICATION' },
              afterData: {
                validationStatus: input.decision,
                reviewedAt: input.reviewedAt.toISOString(),
              },
              reason: input.reason,
              requestId: input.requestId,
            },
          });
          if (row.employee.accountId !== null) {
            await transaction.notification.create({
              data: {
                userAccountId: row.employee.accountId,
                kind: 'ATTENDANCE_VERIFICATION',
                title: `Verifikasi absensi ${decisionText}`,
                message: `Absensi ${row.type === 'CHECK_IN' ? 'masuk' : 'pulang'} Anda ${decisionText}.`,
                payload: { attendanceId: row.id, validationStatus: input.decision },
              },
            });
          }

          return {
            attendanceId: row.id,
            validationStatus: input.decision,
            reviewedAt: input.reviewedAt,
            serverTime: row.serverTime,
            deviceTime: row.deviceTime,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2025')
      ) {
        throw decisionConflict();
      }
      throw error;
    }
  }
}
