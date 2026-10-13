import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  CreatePendingSelfieUploadIntentData,
  PendingSelfieUploadIntent,
  SelfieUploadIntentRepository,
} from './selfie-upload.js';

type SelfieUploadIntentTransaction = Prisma.TransactionClient;

async function findPending(
  client: PrismaClient | SelfieUploadIntentTransaction,
  input: Readonly<{
    referenceHash: string;
    employeeId: string;
    deviceBindingId: string;
    now: Date;
  }>,
): Promise<PendingSelfieUploadIntent | null> {
  const row = await client.selfieUploadIntent.findFirst({
    where: {
      referenceHash: input.referenceHash,
      employeeId: input.employeeId,
      deviceBindingId: input.deviceBindingId,
      status: 'PENDING',
      expiresAt: { gt: input.now },
    },
    select: {
      referenceHash: true,
      employeeId: true,
      deviceBindingId: true,
      objectKey: true,
      sealedObjectKey: true,
      contentType: true,
      declaredSizeBytes: true,
      expiresAt: true,
    },
  });
  if (
    !row?.objectKey ||
    !row.sealedObjectKey ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(row.contentType)
  ) {
    return null;
  }
  return {
    ...row,
    objectKey: row.objectKey,
    sealedObjectKey: row.sealedObjectKey,
    contentType: row.contentType as PendingSelfieUploadIntent['contentType'],
  };
}

export class PrismaSelfieUploadIntentRepository implements SelfieUploadIntentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPending(data: CreatePendingSelfieUploadIntentData): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const bindings = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT b.id
        FROM device_bindings AS b
        INNER JOIN employees AS e ON e.id = b.employee_id
        WHERE b.id = ${data.deviceBindingId}::uuid
          AND b.employee_id = ${data.employeeId}::uuid
          AND b.status = 'APPROVED'
          AND e.status = 'ACTIVE'
        FOR SHARE OF b
        FOR UPDATE OF e
      `);
      if (bindings.length !== 1) {
        throw new AppError(
          403,
          'ATTENDANCE_DEVICE_BINDING_REQUIRED',
          'Profil karyawan aktif dan perangkat yang disetujui diperlukan.',
        );
      }

      await transaction.selfieUploadIntent.create({
        data: {
          referenceHash: data.referenceHash,
          employeeId: data.employeeId,
          deviceBindingId: data.deviceBindingId,
          objectKey: data.objectKey,
          stagingObjectKey: data.objectKey,
          sealedObjectKey: data.sealedObjectKey,
          contentType: data.contentType,
          declaredSizeBytes: data.declaredSizeBytes,
          expiresAt: data.expiresAt,
        },
        select: { referenceHash: true },
      });
    });
  }

  findPendingForVerification(
    input: Parameters<SelfieUploadIntentRepository['findPendingForVerification']>[0],
  ) {
    return findPending(this.prisma, input);
  }

  async findAttachedObjectForAttempt(input: {
    attemptId: string;
    now: Date;
    supervisorUserAccountId?: string;
  }): Promise<Readonly<{
    objectKey: string;
    contentType: string;
    retentionExpiresAt: Date;
  }> | null> {
    const row = await this.prisma.selfieUploadIntent.findFirst({
      where: {
        attachedAttemptId: input.attemptId,
        status: 'ATTACHED',
        objectKey: { not: null },
        deletedAt: null,
        retentionExpiresAt: { gt: input.now },
        ...(input.supervisorUserAccountId === undefined
          ? {}
          : {
              attachedAttempt: {
                is: {
                  attendance: {
                    is: {
                      validationStatus: 'PENDING_VERIFICATION',
                      store: {
                        is: {
                          supervisorAssignments: {
                            some: { supervisorUserAccountId: input.supervisorUserAccountId },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
      },
      select: { objectKey: true, contentType: true, retentionExpiresAt: true },
    });
    return row?.objectKey && row.retentionExpiresAt
      ? {
          objectKey: row.objectKey,
          contentType: row.contentType,
          retentionExpiresAt: row.retentionExpiresAt,
        }
      : null;
  }

  async listAttachedStaging(input: { take: number }) {
    const rows = await this.prisma.selfieUploadIntent.findMany({
      where: { status: 'ATTACHED', stagingObjectKey: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { referenceHash: 'asc' }],
      take: input.take,
      select: { referenceHash: true, stagingObjectKey: true },
    });
    return rows.flatMap((row) =>
      row.stagingObjectKey ? [{ ...row, stagingObjectKey: row.stagingObjectKey }] : [],
    );
  }

  async clearAttachedStaging(input: { referenceHash: string; stagingObjectKey: string }) {
    const result = await this.prisma.selfieUploadIntent.updateMany({
      where: {
        referenceHash: input.referenceHash,
        status: 'ATTACHED',
        stagingObjectKey: input.stagingObjectKey,
      },
      data: { stagingObjectKey: null },
    });
    return result.count === 1;
  }

  async listExpiredAttached(input: { now: Date; take: number }) {
    const rows = await this.prisma.selfieUploadIntent.findMany({
      where: {
        status: 'ATTACHED',
        objectKey: { not: null },
        deletedAt: null,
        retentionExpiresAt: { lte: input.now },
      },
      orderBy: [{ retentionExpiresAt: 'asc' }, { referenceHash: 'asc' }],
      take: input.take,
      select: { referenceHash: true, objectKey: true, attachedAttemptId: true },
    });
    return rows.flatMap((row) => (row.objectKey ? [{ ...row, objectKey: row.objectKey }] : []));
  }

  async markAttachedObjectPurged(input: {
    referenceHash: string;
    objectKey: string;
    attachedAttemptId: string | null;
    deletedAt: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.selfieUploadIntent.updateMany({
        where: {
          referenceHash: input.referenceHash,
          status: 'ATTACHED',
          objectKey: input.objectKey,
          attachedAttemptId: input.attachedAttemptId,
          deletedAt: null,
          retentionExpiresAt: { lte: input.deletedAt },
        },
        data: { objectKey: null, deletedAt: input.deletedAt },
      });
      if (result.count !== 1) return false;

      if (input.attachedAttemptId) {
        const captureResult = await transaction.selfieCapture.updateMany({
          where: {
            objectKey: input.objectKey,
            deletedAt: null,
            retentionExpiresAt: { lte: input.deletedAt },
            attendance: { is: { sourceAttemptId: input.attachedAttemptId } },
          },
          data: { objectKey: null, deletedAt: input.deletedAt },
        });
        if (captureResult.count !== 1) {
          throw new Error('Expired selfie capture reference was not updated');
        }
      }

      return true;
    });
  }

  async claimExpiredPending(input: { now: Date; take: number }) {
    const rows = await this.prisma.selfieUploadIntent.findMany({
      where: {
        status: 'PENDING',
        objectKey: { not: null },
        expiresAt: { lte: input.now },
      },
      orderBy: [{ expiresAt: 'asc' }, { referenceHash: 'asc' }],
      take: input.take,
      select: {
        referenceHash: true,
        objectKey: true,
        sealedObjectKey: true,
        purgeClaimedAt: true,
      },
    });
    const claimed = [];
    for (const row of rows) {
      if (!row.objectKey || !row.sealedObjectKey) continue;
      if (row.purgeClaimedAt) {
        claimed.push({ ...row, objectKey: row.objectKey, sealedObjectKey: row.sealedObjectKey });
        continue;
      }
      const result = await this.prisma.selfieUploadIntent.updateMany({
        where: {
          referenceHash: row.referenceHash,
          status: 'PENDING',
          objectKey: row.objectKey,
          sealedObjectKey: row.sealedObjectKey,
          expiresAt: { lte: input.now },
          purgeClaimedAt: null,
        },
        data: { purgeClaimedAt: input.now },
      });
      if (result.count === 1) {
        claimed.push({ ...row, objectKey: row.objectKey, sealedObjectKey: row.sealedObjectKey });
      }
    }
    return claimed;
  }

  async deleteExpiredPending(input: {
    referenceHash: string;
    objectKey: string;
    now: Date;
  }): Promise<boolean> {
    const result = await this.prisma.selfieUploadIntent.deleteMany({
      where: {
        referenceHash: input.referenceHash,
        status: 'PENDING',
        objectKey: input.objectKey,
        expiresAt: { lte: input.now },
        purgeClaimedAt: { not: null },
      },
    });
    return result.count === 1;
  }
}
