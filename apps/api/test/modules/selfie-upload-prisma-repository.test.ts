import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/errors/app-error.js';
import { PrismaSelfieUploadIntentRepository } from '../../src/modules/attendance/prisma-selfie-upload-repository.js';
import type { CreatePendingSelfieUploadIntentData } from '../../src/modules/attendance/selfie-upload.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000061';
const BINDING_ID = '00000000-0000-4000-8000-000000000062';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000063';
const REFERENCE_HASH = 'a'.repeat(64);
const NOW = new Date('2026-10-11T03:00:00.000Z');
type UpdateManyArgs = Readonly<{
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}>;

const pending: CreatePendingSelfieUploadIntentData = {
  referenceHash: REFERENCE_HASH,
  employeeId: EMPLOYEE_ID,
  deviceBindingId: BINDING_ID,
  objectKey: 'attendance/selfie-staging/opaque-key',
  sealedObjectKey: 'attendance/selfie-accepted/reserved-key',
  contentType: 'image/jpeg',
  declaredSizeBytes: 12_345,
  expiresAt: new Date(NOW.getTime() + 120_000),
};

function setup(
  overrides: Record<string, unknown> = {},
  captureOverrides: Record<string, unknown> = {},
) {
  const intent = {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({ referenceHash: REFERENCE_HASH })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    ...overrides,
  };
  const selfieCapture = { updateMany: vi.fn(async () => ({ count: 1 })), ...captureOverrides };
  const attendance = { deleteMany: vi.fn(async () => ({ count: 0 })) };
  const attendanceAttempt = { deleteMany: vi.fn(async () => ({ count: 0 })) };
  const auditLog = { deleteMany: vi.fn(async () => ({ count: 0 })) };
  const transaction = {
    $queryRaw: vi.fn(async (_query: Prisma.Sql) => {
      void _query;
      return [{ id: BINDING_ID }];
    }),
    selfieUploadIntent: intent,
    selfieCapture,
    attendance,
    attendanceAttempt,
    auditLog,
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(transaction),
    ),
    selfieUploadIntent: intent,
  };
  return {
    repository: new PrismaSelfieUploadIntentRepository(prisma as never),
    prisma,
    transaction,
    intent,
    selfieCapture,
    attendance,
    attendanceAttempt,
    auditLog,
  };
}

describe('PrismaSelfieUploadIntentRepository', () => {
  it('creates an intent only after locking an active employee and approved binding', async () => {
    const { repository, transaction, intent } = setup();

    await repository.createPending(pending);

    const sql = transaction.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.sql).toContain("b.status = 'APPROVED'");
    expect(sql.sql).toContain("e.status = 'ACTIVE'");
    expect(sql.sql).toContain('FOR SHARE OF b');
    expect(sql.sql).toContain('FOR UPDATE OF e');
    expect(intent.create).toHaveBeenCalledWith({
      data: {
        referenceHash: pending.referenceHash,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
        objectKey: pending.objectKey,
        stagingObjectKey: pending.objectKey,
        sealedObjectKey: pending.sealedObjectKey,
        contentType: pending.contentType,
        declaredSizeBytes: pending.declaredSizeBytes,
        expiresAt: pending.expiresAt,
      },
      select: { referenceHash: true },
    });
  });

  it('rejects inactive or unbound users without inserting an intent', async () => {
    const { repository, transaction, intent } = setup();
    transaction.$queryRaw.mockResolvedValue([]);

    await expect(repository.createPending(pending)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ATTENDANCE_DEVICE_BINDING_REQUIRED',
    } satisfies Partial<AppError>);
    expect(intent.create).not.toHaveBeenCalled();
  });

  it('looks up only an unexpired pending intent belonging to the exact employee/device', async () => {
    const row = { ...pending };
    const { repository, intent } = setup({ findFirst: vi.fn(async () => row) });
    const result = await repository.findPendingForVerification({
      referenceHash: REFERENCE_HASH,
      employeeId: EMPLOYEE_ID,
      deviceBindingId: BINDING_ID,
      now: NOW,
    });

    expect(result).toEqual(row);
    expect(intent.findFirst).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
        status: 'PENDING',
        expiresAt: { gt: NOW },
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
  });

  it('finds only retained attached selfie keys for Admin reads', async () => {
    const { repository, intent } = setup({
      findFirst: vi.fn(async () => ({
        objectKey: 'attendance/selfie-accepted/key',
        watermarkedObjectKey: 'attendance/selfie-watermarked/key',
        watermarkApplied: true,
        contentType: 'image/jpeg',
        retentionExpiresAt: new Date(NOW.getTime() + 10_000),
      })),
    });
    const result = await repository.findAttachedObjectForAttempt({
      attemptId: ATTEMPT_ID,
      now: NOW,
    });

    expect(result).toEqual({
      objectKey: 'attendance/selfie-watermarked/key',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() + 10_000),
      watermarkApplied: true,
    });
    expect(intent.findFirst).toHaveBeenCalledWith({
      where: {
        attachedAttemptId: ATTEMPT_ID,
        status: 'ATTACHED',
        objectKey: { not: null },
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
      },
      select: {
        objectKey: true,
        watermarkedObjectKey: true,
        watermarkApplied: true,
        contentType: true,
        retentionExpiresAt: true,
      },
    });
  });

  it('reserves one immutable derivative key and returns only the DB-bound source metadata', async () => {
    const row = {
      referenceHash: REFERENCE_HASH,
      objectKey: 'attendance/selfie-accepted/original',
      watermarkedObjectKey: null,
      watermarkApplied: false,
      contentType: 'image/jpeg',
      declaredSizeBytes: 12_345,
      retentionExpiresAt: new Date(NOW.getTime() + 60_000),
      watermarkMetadata: { employeeName: 'Karyawan Uji', serverTime: NOW.toISOString() },
    };
    const { repository, intent, transaction } = setup({
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({
          ...row,
          watermarkedObjectKey: 'attendance/selfie-watermarked/reserved',
        }),
    });

    await expect(
      repository.reserveWatermarkedObjectForAttempt({
        attemptId: ATTEMPT_ID,
        candidateObjectKey: 'attendance/selfie-watermarked/candidate',
        now: NOW,
      }),
    ).resolves.toEqual({
      referenceHash: REFERENCE_HASH,
      objectKey: 'attendance/selfie-accepted/original',
      watermarkedObjectKey: 'attendance/selfie-watermarked/reserved',
      watermarkApplied: false,
      contentType: 'image/jpeg',
      sizeBytes: 12_345,
      retentionExpiresAt: new Date(NOW.getTime() + 60_000),
      watermarkMetadata: row.watermarkMetadata,
    });
    expect(transaction.selfieUploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        attachedAttemptId: ATTEMPT_ID,
        objectKey: row.objectKey,
        watermarkedObjectKey: null,
        watermarkApplied: false,
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
      },
      data: { watermarkedObjectKey: 'attendance/selfie-watermarked/candidate' },
    });
    expect(intent.findFirst).toHaveBeenCalledTimes(2);
  });

  it('commits watermark state and capture flag only after the derivative exists', async () => {
    const { repository, transaction, selfieCapture } = setup();

    await expect(
      repository.markWatermarkApplied({
        attemptId: ATTEMPT_ID,
        referenceHash: REFERENCE_HASH,
        originalObjectKey: 'attendance/selfie-accepted/original',
        watermarkedObjectKey: 'attendance/selfie-watermarked/ready',
        sizeBytes: 10_000,
        now: NOW,
      }),
    ).resolves.toBe(true);
    expect(transaction.selfieUploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        attachedAttemptId: ATTEMPT_ID,
        status: 'ATTACHED',
        objectKey: 'attendance/selfie-accepted/original',
        watermarkedObjectKey: 'attendance/selfie-watermarked/ready',
        watermarkApplied: false,
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
      },
      data: { watermarkApplied: true, watermarkedSizeBytes: 10_000 },
    });
    expect(selfieCapture.updateMany).toHaveBeenCalledWith({
      where: {
        objectKey: 'attendance/selfie-accepted/original',
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
        attendance: { is: { sourceAttemptId: ATTEMPT_ID } },
      },
      data: { watermarkApplied: true },
    });
  });

  it('selects only retained attached attempts whose watermark has not been applied', async () => {
    const { repository, intent } = setup({
      findMany: vi.fn(async () => [{ attachedAttemptId: ATTEMPT_ID }]),
    });

    await expect(repository.listPendingWatermarkAttempts({ now: NOW, take: 20 })).resolves.toEqual([
      ATTEMPT_ID,
    ]);
    expect(intent.findMany).toHaveBeenCalledWith({
      where: {
        status: 'ATTACHED',
        attachedAttemptId: { not: null },
        objectKey: { not: null },
        watermarkApplied: false,
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
      },
      orderBy: [{ createdAt: 'asc' }, { referenceHash: 'asc' }],
      take: 20,
      select: { attachedAttemptId: true },
    });
  });

  it('previews only bounded candidate counts with read queries and no database mutation', async () => {
    const { repository, prisma, intent, selfieCapture } = setup({
      findMany: vi.fn(async () => [{ referenceHash: REFERENCE_HASH }]),
    });

    await expect(repository.previewRetentionCandidates({ now: NOW, take: 10 })).resolves.toEqual({
      watermarkCandidates: 1,
      attachedStagingCandidates: 1,
      expiredAttachedCandidates: 1,
      expiredPendingCandidates: 1,
      batchLimitHit: {
        watermark: false,
        attachedStaging: false,
        expiredAttached: false,
        expiredPending: false,
      },
    });
    expect(intent.findMany.mock.calls).toHaveLength(4);
    expect(intent.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'ATTACHED',
        attachedAttemptId: { not: null },
        objectKey: { not: null },
        watermarkApplied: false,
        deletedAt: null,
        retentionExpiresAt: { gt: NOW },
      },
      orderBy: [{ createdAt: 'asc' }, { referenceHash: 'asc' }],
      take: 10,
      select: { attachedAttemptId: true },
    });
    expect(intent.findMany).toHaveBeenNthCalledWith(2, {
      where: { status: 'ATTACHED', stagingObjectKey: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { referenceHash: 'asc' }],
      take: 10,
      select: { referenceHash: true },
    });
    expect(intent.findMany).toHaveBeenNthCalledWith(3, {
      where: {
        status: 'ATTACHED',
        objectKey: { not: null },
        deletedAt: null,
        retentionExpiresAt: { lte: NOW },
      },
      orderBy: [{ retentionExpiresAt: 'asc' }, { referenceHash: 'asc' }],
      take: 10,
      select: { referenceHash: true },
    });
    expect(intent.findMany).toHaveBeenNthCalledWith(4, {
      where: {
        status: 'PENDING',
        objectKey: { not: null },
        sealedObjectKey: { not: null },
        expiresAt: { lte: NOW },
      },
      orderBy: [{ expiresAt: 'asc' }, { referenceHash: 'asc' }],
      take: 10,
      select: { referenceHash: true },
    });
    expect(intent.updateMany.mock.calls).toHaveLength(0);
    expect(intent.deleteMany.mock.calls).toHaveLength(0);
    expect(selfieCapture.updateMany.mock.calls).toHaveLength(0);
    expect(prisma.$transaction.mock.calls).toHaveLength(0);
  });

  it('atomically clears expired selfie references while preserving attendance and audit rows', async () => {
    const {
      repository,
      prisma,
      transaction,
      intent,
      selfieCapture,
      attendance,
      attendanceAttempt,
      auditLog,
    } = setup({
      findMany: vi.fn(async () => [
        {
          referenceHash: REFERENCE_HASH,
          objectKey: 'attendance/selfie-accepted/expired',
          watermarkedObjectKey: 'attendance/selfie-watermarked/expired',
          attachedAttemptId: ATTEMPT_ID,
        },
      ]),
    });
    const expired = await repository.listExpiredAttached({ now: NOW, take: 100 });
    expect(expired).toEqual([
      {
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/expired',
        watermarkedObjectKey: 'attendance/selfie-watermarked/expired',
        attachedAttemptId: ATTEMPT_ID,
      },
    ]);
    expect(intent.findMany).toHaveBeenCalledWith({
      where: {
        status: 'ATTACHED',
        objectKey: { not: null },
        deletedAt: null,
        retentionExpiresAt: { lte: NOW },
      },
      orderBy: [{ retentionExpiresAt: 'asc' }, { referenceHash: 'asc' }],
      take: 100,
      select: {
        referenceHash: true,
        objectKey: true,
        watermarkedObjectKey: true,
        attachedAttemptId: true,
      },
    });

    await expect(
      repository.markAttachedObjectPurged({
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/expired',
        watermarkedObjectKey: 'attendance/selfie-watermarked/expired',
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: NOW,
      }),
    ).resolves.toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(transaction.selfieCapture).toBe(selfieCapture);
    expect(intent.updateMany).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        status: 'ATTACHED',
        objectKey: 'attendance/selfie-accepted/expired',
        watermarkedObjectKey: 'attendance/selfie-watermarked/expired',
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: null,
        retentionExpiresAt: { lte: NOW },
      },
      data: {
        objectKey: null,
        watermarkedObjectKey: null,
        watermarkedSizeBytes: null,
        watermarkApplied: false,
        deletedAt: NOW,
      },
    });
    expect(selfieCapture.updateMany).toHaveBeenCalledWith({
      where: {
        objectKey: 'attendance/selfie-accepted/expired',
        deletedAt: null,
        retentionExpiresAt: { lte: NOW },
        attendance: { is: { sourceAttemptId: ATTEMPT_ID } },
      },
      data: { objectKey: null, deletedAt: NOW },
    });
    await expect(selfieCapture.updateMany.mock.results[0]?.value).resolves.toEqual({ count: 1 });
    expect(attendance.deleteMany).not.toHaveBeenCalled();
    expect(attendanceAttempt.deleteMany).not.toHaveBeenCalled();
    expect(auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('does not clear the capture pointer when another retention worker already claimed the intent', async () => {
    const { repository, intent, selfieCapture } = setup({
      updateMany: vi.fn(async () => ({ count: 0 })),
    });

    await expect(
      repository.markAttachedObjectPurged({
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/racing',
        watermarkedObjectKey: null,
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: NOW,
      }),
    ).resolves.toBe(false);

    expect(intent.updateMany).toHaveBeenCalledTimes(1);
    expect(selfieCapture.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back an intent purge when its capture pointer is not updated and keeps it retryable', async () => {
    const objectKey = 'attendance/selfie-accepted/rollback';
    const state = {
      intentObjectKey: objectKey as string | null,
      intentDeletedAt: null as Date | null,
      captureObjectKey: objectKey as string | null,
      captureDeletedAt: null as Date | null,
    };
    let captureUpdateCount = 0;
    const captureUpdate = vi.fn(async ({ where, data }: UpdateManyArgs) => {
      if (where.objectKey !== state.captureObjectKey || captureUpdateCount !== 1) {
        return { count: captureUpdateCount };
      }
      state.captureObjectKey = data.objectKey as string | null;
      state.captureDeletedAt = data.deletedAt as Date;
      return { count: 1 };
    });
    const {
      repository,
      prisma,
      transaction,
      selfieCapture,
      attendance,
      attendanceAttempt,
      auditLog,
    } = setup(
      {
        findMany: vi.fn(async () =>
          state.intentObjectKey && state.intentDeletedAt === null
            ? [
                {
                  referenceHash: REFERENCE_HASH,
                  objectKey: state.intentObjectKey,
                  watermarkedObjectKey: null,
                  attachedAttemptId: ATTEMPT_ID,
                },
              ]
            : [],
        ),
        updateMany: vi.fn(async ({ where, data }: UpdateManyArgs) => {
          if (
            where.referenceHash !== REFERENCE_HASH ||
            where.objectKey !== state.intentObjectKey ||
            state.intentDeletedAt !== null
          ) {
            return { count: 0 };
          }
          state.intentObjectKey = data.objectKey as string | null;
          state.intentDeletedAt = data.deletedAt as Date;
          return { count: 1 };
        }),
      },
      { updateMany: captureUpdate },
    );
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const before = { ...state };
      try {
        return await callback(transaction);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    });

    await expect(
      repository.markAttachedObjectPurged({
        referenceHash: REFERENCE_HASH,
        objectKey,
        watermarkedObjectKey: null,
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: NOW,
      }),
    ).rejects.toThrow('Expired selfie capture reference was not updated');

    expect(state).toEqual({
      intentObjectKey: 'attendance/selfie-accepted/rollback',
      intentDeletedAt: null,
      captureObjectKey: 'attendance/selfie-accepted/rollback',
      captureDeletedAt: null,
    });
    await expect(repository.listExpiredAttached({ now: NOW, take: 100 })).resolves.toEqual([
      {
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/rollback',
        watermarkedObjectKey: null,
        attachedAttemptId: ATTEMPT_ID,
      },
    ]);
    expect(selfieCapture.updateMany).toHaveBeenCalledWith({
      where: {
        objectKey: 'attendance/selfie-accepted/rollback',
        deletedAt: null,
        retentionExpiresAt: { lte: NOW },
        attendance: { is: { sourceAttemptId: ATTEMPT_ID } },
      },
      data: { objectKey: null, deletedAt: NOW },
    });
    expect(attendance.deleteMany).not.toHaveBeenCalled();
    expect(attendanceAttempt.deleteMany).not.toHaveBeenCalled();
    expect(auditLog.deleteMany).not.toHaveBeenCalled();

    captureUpdateCount = 1;
    await expect(
      repository.markAttachedObjectPurged({
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/rollback',
        watermarkedObjectKey: null,
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: NOW,
      }),
    ).resolves.toBe(true);
    expect(state).toEqual({
      intentObjectKey: null,
      intentDeletedAt: NOW,
      captureObjectKey: null,
      captureDeletedAt: NOW,
    });
  });

  it('propagates capture-reference cleanup failures to the surrounding transaction', async () => {
    const { repository, prisma, intent, selfieCapture } = setup();
    const failure = new Error('capture reference update failed');
    selfieCapture.updateMany.mockRejectedValueOnce(failure);

    await expect(
      repository.markAttachedObjectPurged({
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-accepted/transactional',
        watermarkedObjectKey: null,
        attachedAttemptId: ATTEMPT_ID,
        deletedAt: NOW,
      }),
    ).rejects.toBe(failure);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(intent.updateMany).toHaveBeenCalledTimes(1);
    expect(selfieCapture.updateMany).toHaveBeenCalledTimes(1);
  });

  it('cleans sealed uploads staging copies separately and then removes expired orphan intents', async () => {
    const { repository, intent } = setup({
      findMany: vi.fn(async () => [
        { referenceHash: REFERENCE_HASH, stagingObjectKey: 'attendance/selfie-staging/old-copy' },
      ]),
    });

    await expect(repository.listAttachedStaging({ take: 20 })).resolves.toEqual([
      {
        referenceHash: REFERENCE_HASH,
        stagingObjectKey: 'attendance/selfie-staging/old-copy',
      },
    ]);
    expect(intent.findMany).toHaveBeenCalledWith({
      where: { status: 'ATTACHED', stagingObjectKey: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { referenceHash: 'asc' }],
      take: 20,
      select: { referenceHash: true, stagingObjectKey: true },
    });
    await expect(
      repository.clearAttachedStaging({
        referenceHash: REFERENCE_HASH,
        stagingObjectKey: 'attendance/selfie-staging/old-copy',
      }),
    ).resolves.toBe(true);
    expect(intent.updateMany).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        status: 'ATTACHED',
        stagingObjectKey: 'attendance/selfie-staging/old-copy',
      },
      data: { stagingObjectKey: null },
    });

    const expired = setup({
      findMany: vi.fn(async () => [
        {
          referenceHash: REFERENCE_HASH,
          objectKey: 'attendance/selfie-staging/orphan',
          sealedObjectKey: 'attendance/selfie-accepted/orphan',
          purgeClaimedAt: null,
        },
      ]),
    });
    await expect(expired.repository.claimExpiredPending({ now: NOW, take: 10 })).resolves.toEqual([
      {
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-staging/orphan',
        sealedObjectKey: 'attendance/selfie-accepted/orphan',
        purgeClaimedAt: null,
      },
    ]);
    expect(expired.intent.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        referenceHash: REFERENCE_HASH,
        status: 'PENDING',
        objectKey: 'attendance/selfie-staging/orphan',
        sealedObjectKey: 'attendance/selfie-accepted/orphan',
        expiresAt: { lte: NOW },
        purgeClaimedAt: null,
      },
      data: { purgeClaimedAt: NOW },
    });
    await expect(
      expired.repository.deleteExpiredPending({
        referenceHash: REFERENCE_HASH,
        objectKey: 'attendance/selfie-staging/orphan',
        now: NOW,
      }),
    ).resolves.toBe(true);
    expect(expired.intent.deleteMany).toHaveBeenCalledWith({
      where: {
        referenceHash: REFERENCE_HASH,
        status: 'PENDING',
        objectKey: 'attendance/selfie-staging/orphan',
        expiresAt: { lte: NOW },
        purgeClaimedAt: { not: null },
      },
    });
  });

  it('does not return expired uploads when another consumer wins the purge claim', async () => {
    const { repository, intent } = setup({
      findMany: vi.fn(async () => [
        {
          referenceHash: REFERENCE_HASH,
          objectKey: 'attendance/selfie-staging/racing',
          sealedObjectKey: 'attendance/selfie-accepted/racing',
          purgeClaimedAt: null,
        },
      ]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    });

    await expect(repository.claimExpiredPending({ now: NOW, take: 10 })).resolves.toEqual([]);
    expect(intent.updateMany).toHaveBeenCalledTimes(1);
  });
});
