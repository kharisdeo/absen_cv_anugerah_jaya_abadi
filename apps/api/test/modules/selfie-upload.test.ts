import { describe, expect, it, vi } from 'vitest';

import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import type {
  CreatePendingSelfieUploadIntentData,
  PendingSelfieUploadIntent,
  SelfieUploadIntentRepository,
} from '../../src/modules/attendance/selfie-upload.js';
import {
  SelfieUploadService,
  selfieUploadIntentBodySchema,
} from '../../src/modules/attendance/selfie-upload.js';
import type {
  PrivateSelfieObject,
  PrivateSelfieStorage,
  SignedSelfieUpload,
} from '../../src/modules/attendance/private-selfie-storage.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000031';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000032';
const BINDING_ID = '00000000-0000-4000-8000-000000000033';
const NOW = new Date('2026-10-11T03:00:00.000Z');
const INPUT = { contentType: 'image/jpeg', sizeBytes: 10_240 } as const;

function principal(role: UserRole = UserRole.EMPLOYEE): AuthPrincipal {
  return {
    userAccountId: ACCOUNT_ID,
    role,
    username: 'test-employee',
    employeeId: EMPLOYEE_ID,
    deviceBindingId: BINDING_ID,
    deviceBindingStatus: DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: 'selfie-upload-session',
    lastSeenAt: NOW,
  };
}

class MemoryIntentRepository implements SelfieUploadIntentRepository {
  readonly rows = new Map<string, PendingSelfieUploadIntent>();
  readonly purgeClaims = new Set<string>();
  readonly attached: Array<{
    referenceHash: string;
    attemptId: string;
    objectKey: string;
    contentType: string;
    retentionExpiresAt: Date;
    stagingObjectKey?: string | null;
  }> = [];

  async createPending(data: CreatePendingSelfieUploadIntentData) {
    this.rows.set(data.referenceHash, data);
  }

  async findPendingForVerification(input: {
    referenceHash: string;
    employeeId: string;
    deviceBindingId: string;
    now: Date;
  }) {
    const row = this.rows.get(input.referenceHash);
    if (
      !row ||
      row.employeeId !== input.employeeId ||
      row.deviceBindingId !== input.deviceBindingId ||
      row.expiresAt.getTime() <= input.now.getTime()
    ) {
      return null;
    }
    return row;
  }

  async findAttachedObjectForAttempt({ attemptId, now }: { attemptId: string; now: Date }) {
    const selfie = this.attached.find(
      (candidate) => candidate.attemptId === attemptId && candidate.retentionExpiresAt > now,
    );
    return selfie
      ? {
          objectKey: selfie.objectKey,
          contentType: selfie.contentType,
          retentionExpiresAt: selfie.retentionExpiresAt,
        }
      : null;
  }

  async listAttachedStaging({ take }: { take: number }) {
    return this.attached
      .filter((selfie) => selfie.stagingObjectKey)
      .slice(0, take)
      .map((selfie) => ({
        referenceHash: selfie.referenceHash,
        stagingObjectKey: selfie.stagingObjectKey!,
      }));
  }

  async clearAttachedStaging({
    referenceHash,
    stagingObjectKey,
  }: {
    referenceHash: string;
    stagingObjectKey: string;
  }) {
    const selfie = this.attached.find(
      (candidate) =>
        candidate.referenceHash === referenceHash &&
        candidate.stagingObjectKey === stagingObjectKey,
    );
    if (!selfie) return false;
    selfie.stagingObjectKey = null;
    return true;
  }

  async listExpiredAttached({ now, take }: { now: Date; take: number }) {
    return this.attached
      .filter((selfie) => selfie.retentionExpiresAt <= now)
      .slice(0, take)
      .map(({ referenceHash, attemptId, objectKey }) => ({
        referenceHash,
        objectKey,
        attachedAttemptId: attemptId,
      }));
  }

  async markAttachedObjectPurged({
    referenceHash,
    objectKey,
    attachedAttemptId,
  }: {
    referenceHash: string;
    objectKey: string;
    attachedAttemptId: string | null;
  }) {
    const index = this.attached.findIndex(
      (selfie) =>
        selfie.referenceHash === referenceHash &&
        selfie.attemptId === attachedAttemptId &&
        selfie.objectKey === objectKey,
    );
    if (index < 0) return false;
    this.attached.splice(index, 1);
    return true;
  }

  async claimExpiredPending({ now, take }: { now: Date; take: number }) {
    return [...this.rows.values()]
      .filter((intent) => intent.expiresAt <= now)
      .slice(0, take)
      .flatMap((intent) => {
        if (this.purgeClaims.has(intent.referenceHash)) return [intent];
        this.purgeClaims.add(intent.referenceHash);
        return [intent];
      })
      .map(({ referenceHash, objectKey, sealedObjectKey }) => ({
        referenceHash,
        objectKey,
        sealedObjectKey,
      }));
  }

  async deleteExpiredPending({
    referenceHash,
    objectKey,
  }: {
    referenceHash: string;
    objectKey: string;
  }) {
    const intent = this.rows.get(referenceHash);
    if (!intent || intent.objectKey !== objectKey || !this.purgeClaims.has(referenceHash))
      return false;
    this.purgeClaims.delete(referenceHash);
    return this.rows.delete(referenceHash);
  }
}

function validObject(overrides: Partial<PrivateSelfieObject> = {}): PrivateSelfieObject {
  return {
    contentType: 'image/jpeg',
    sizeBytes: INPUT.sizeBytes,
    referenceHash: 'a'.repeat(64),
    imageType: 'jpg',
    width: 640,
    height: 480,
    entityTag: '"etag-1"',
    bytes: new Uint8Array(INPUT.sizeBytes),
    ...overrides,
  };
}

function harness(
  options: {
    object?: PrivateSelfieObject | null;
    now?: () => Date;
    createUploadUrl?: PrivateSelfieStorage['createUploadUrl'];
    inspectObject?: PrivateSelfieStorage['inspectObject'];
    sealObject?: PrivateSelfieStorage['sealObject'];
  } = {},
) {
  const repository = new MemoryIntentRepository();
  const signed: SignedSelfieUpload = {
    url: 'https://storage.example.test/signed-put?signature=secret',
    headers: {
      'Content-Type': INPUT.contentType,
      'x-amz-meta-referencehash': 'reference-hash',
    },
  };
  const storage: PrivateSelfieStorage = {
    createUploadUrl: options.createUploadUrl ?? vi.fn(async () => signed),
    inspectObject:
      options.inspectObject ??
      vi.fn(async (objectKey) => {
        const row = [...repository.rows.values()].find(
          (candidate) =>
            candidate.objectKey === objectKey || candidate.sealedObjectKey === objectKey,
        );
        if ('object' in options && !options.object) return null;
        const object = 'object' in options ? options.object : validObject();
        if (!object) return null;
        return {
          ...object,
          ...(object.referenceHash === 'a'.repeat(64) && row
            ? { referenceHash: row.referenceHash }
            : {}),
        };
      }),
    sealObject: options.sealObject ?? vi.fn(async () => {}),
    createReadUrl: vi.fn(async () => 'https://storage.example.test/signed-get?signature=secret'),
    deleteObject: vi.fn(async () => {}),
  };
  const service = new SelfieUploadService(repository, storage, 120, options.now ?? (() => NOW));
  return { repository, storage, service };
}

describe('selfie upload intent contract', () => {
  it('accepts only small supported image uploads with strict body fields', () => {
    expect(selfieUploadIntentBodySchema.safeParse(INPUT).success).toBe(true);
    expect(
      selfieUploadIntentBodySchema.safeParse({ contentType: 'image/jpeg', sizeBytes: 204_800 })
        .success,
    ).toBe(true);
    for (const invalid of [
      { contentType: 'image/gif', sizeBytes: 100 },
      { contentType: 'image/jpeg', sizeBytes: 0 },
      { contentType: 'image/jpeg', sizeBytes: 204_801 },
      { ...INPUT, objectKey: 'forged/key' },
      { contentType: 'image/jpeg', sizeBytes: 1.5 },
    ]) {
      expect(selfieUploadIntentBodySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('returns a random reference and short-lived signed upload without exposing object keys', async () => {
    const { service, storage, repository } = harness();
    const employeeWithNikUsername = { ...principal(), username: '3201010101010001' };
    const receipt = await service.createUploadIntent(employeeWithNikUsername, INPUT);
    const intent = [...repository.rows.values()][0]!;
    const generatedKeys = `${intent.objectKey} ${intent.sealedObjectKey}`;

    expect(receipt).toMatchObject({
      referenceId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      uploadUrl: expect.stringContaining('https://storage.example.test/'),
      requiredHeaders: {
        'Content-Type': INPUT.contentType,
        'x-amz-meta-referencehash': 'reference-hash',
      },
      expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    });
    expect(receipt).not.toHaveProperty('objectKey');
    expect(intent.objectKey).toMatch(/^attendance\/selfie-staging\/[0-9a-f-]{36}$/i);
    expect(intent.sealedObjectKey).toMatch(/^attendance\/selfie-accepted\/[0-9a-f-]{36}$/i);
    expect(generatedKeys).not.toContain(employeeWithNikUsername.username);
    expect(generatedKeys).not.toContain(EMPLOYEE_ID);
    expect(repository.rows.size).toBe(1);
    expect(intent).toMatchObject({
      employeeId: EMPLOYEE_ID,
      deviceBindingId: BINDING_ID,
      objectKey: expect.stringMatching(/^attendance\/selfie-staging\//),
      sealedObjectKey: expect.stringMatching(/^attendance\/selfie-accepted\//),
      contentType: INPUT.contentType,
      declaredSizeBytes: INPUT.sizeBytes,
      expiresAt: new Date(NOW.getTime() + 120_000),
    });
    expect(JSON.stringify([...repository.rows.values()])).not.toContain(receipt.referenceId);
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: INPUT.contentType,
        expiresInSeconds: 120,
        referenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        objectKey: expect.stringMatching(/^attendance\/selfie-staging\//),
      }),
    );
  });

  it('rejects non-employees and missing device bindings before making a signed URL', async () => {
    const { service, storage, repository } = harness();
    await expect(
      service.createUploadIntent(principal(UserRole.ADMIN), INPUT),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(
      service.createUploadIntent(
        { ...principal(), deviceBindingId: null, deviceBindingStatus: null },
        INPUT,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ATTENDANCE_DEVICE_BINDING_REQUIRED' });
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
    expect(repository.rows.size).toBe(0);
  });

  it('verifies owner, device, expiry, declared size, MIME signature, metadata, and seals the accepted bytes', async () => {
    const { service, repository, storage } = harness();
    const receipt = await service.createUploadIntent(principal(), INPUT);
    const intent = [...repository.rows.values()][0]!;
    const verified = await service.verifyPrivateSelfieReference({
      referenceId: receipt.referenceId,
      employeeId: EMPLOYEE_ID,
      deviceBindingId: BINDING_ID,
    });

    expect(verified).toEqual({
      sizeBytes: INPUT.sizeBytes,
      stagedObjectKey: intent.objectKey,
      sealedObjectKey: intent.sealedObjectKey,
    });
    expect(storage.sealObject).toHaveBeenCalledWith({
      sealedObjectKey: intent.sealedObjectKey,
      bytes: expect.any(Uint8Array),
      contentType: INPUT.contentType,
      referenceHash: intent.referenceHash,
    });
  });

  it('rejects mismatched ownership, device, or expired upload references without inspecting storage', async () => {
    let now = NOW;
    const { service, storage } = harness({ now: () => now });
    const receipt = await service.createUploadIntent(principal(), INPUT);

    for (const input of [
      {
        referenceId: receipt.referenceId,
        employeeId: '00000000-0000-4000-8000-000000000099',
        deviceBindingId: BINDING_ID,
      },
      {
        referenceId: receipt.referenceId,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: '00000000-0000-4000-8000-000000000099',
      },
    ]) {
      await expect(service.verifyPrivateSelfieReference(input)).rejects.toMatchObject({
        statusCode: 422,
        code: 'ATTENDANCE_EVIDENCE_INVALID',
      });
    }
    now = new Date(NOW.getTime() + 121_000);
    await expect(
      service.verifyPrivateSelfieReference({
        referenceId: receipt.referenceId,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'ATTENDANCE_EVIDENCE_INVALID' });
    expect(storage.inspectObject).not.toHaveBeenCalled();
  });

  it('rejects missing, corrupted, oversized, mis-typed, or reference-mismatched objects', async () => {
    const badObjects: Array<PrivateSelfieObject | null> = [
      null,
      validObject({ sizeBytes: INPUT.sizeBytes + 1 }),
      validObject({ sizeBytes: 204_801 }),
      validObject({ contentType: 'image/png' }),
      validObject({ imageType: 'png' }),
      validObject({ referenceHash: 'c'.repeat(64) }),
      validObject({ width: undefined }),
      validObject({ entityTag: undefined }),
    ];

    for (const object of badObjects) {
      const { service, storage } = harness({ object });
      const receipt = await service.createUploadIntent(principal(), INPUT);
      await expect(
        service.verifyPrivateSelfieReference({
          referenceId: receipt.referenceId,
          employeeId: EMPLOYEE_ID,
          deviceBindingId: BINDING_ID,
        }),
      ).rejects.toMatchObject({ code: 'ATTENDANCE_EVIDENCE_INVALID' });
      expect(storage.sealObject).not.toHaveBeenCalled();
    }
  });

  it('reuses only a valid already-sealed object after a conditional copy race', async () => {
    const { service, repository } = harness({
      sealObject: async () => {
        throw new AppError(422, 'ATTENDANCE_EVIDENCE_INVALID', 'Already sealed.');
      },
    });
    const receipt = await service.createUploadIntent(principal(), INPUT);
    const intent = [...repository.rows.values()][0]!;

    await expect(
      service.verifyPrivateSelfieReference({
        referenceId: receipt.referenceId,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
      }),
    ).resolves.toEqual({
      sizeBytes: INPUT.sizeBytes,
      stagedObjectKey: intent.objectKey,
      sealedObjectKey: intent.sealedObjectKey,
    });
  });

  it('fails closed when storage cannot sign, inspect, or seal evidence', async () => {
    const signerFailure = harness({
      createUploadUrl: async () => {
        throw new Error('secret provider detail');
      },
    });
    await expect(
      signerFailure.service.createUploadIntent(principal(), INPUT),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    });

    const inspectFailure = harness({
      inspectObject: async () => {
        throw new Error('storage read failed');
      },
    });
    const inspectReceipt = await inspectFailure.service.createUploadIntent(principal(), INPUT);
    await expect(
      inspectFailure.service.verifyPrivateSelfieReference({
        referenceId: inspectReceipt.referenceId,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    });

    const sealFailure = harness({
      sealObject: async () => {
        throw new AppError(503, 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE', 'Unavailable');
      },
    });
    const sealReceipt = await sealFailure.service.createUploadIntent(principal(), INPUT);
    await expect(
      sealFailure.service.verifyPrivateSelfieReference({
        referenceId: sealReceipt.referenceId,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    });
  });

  it('authorizes signed selfie reads for Admin only and only while evidence is retained', async () => {
    const { service, repository, storage } = harness();
    repository.attached.push({
      referenceHash: 'd'.repeat(64),
      attemptId: '00000000-0000-4000-8000-000000000051',
      objectKey: 'attendance/selfie-accepted/for-review',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() + 10_000),
    });

    await expect(
      service.createReadUrl(principal(), '00000000-0000-4000-8000-000000000051'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    const signed = await service.createReadUrl(
      principal(UserRole.ADMIN),
      '00000000-0000-4000-8000-000000000051',
    );

    expect(signed).toEqual({
      url: 'https://storage.example.test/signed-get?signature=secret',
      expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
    });
    expect(storage.createReadUrl).toHaveBeenCalledWith({
      objectKey: 'attendance/selfie-accepted/for-review',
      expiresInSeconds: 10,
    });

    await expect(
      service.createReadUrl(principal(UserRole.ADMIN), '00000000-0000-4000-8000-000000000052'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'SELFIE_NOT_FOUND' });
  });

  it('issues review signed URLs only to Admin or Supervisor and passes Supervisor identity for DB scope enforcement', async () => {
    const { service, repository, storage } = harness();
    const attemptId = '00000000-0000-4000-8000-000000000053';
    repository.attached.push({
      referenceHash: 'e'.repeat(64),
      attemptId,
      objectKey: 'attendance/selfie-accepted/review-scope',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const findAttached = vi.spyOn(repository, 'findAttachedObjectForAttempt');

    await expect(service.createReviewReadUrl(principal(), attemptId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    const signed = await service.createReviewReadUrl(principal(UserRole.SUPERVISOR), attemptId);

    expect(signed.expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(findAttached).toHaveBeenCalledWith({
      attemptId,
      now: NOW,
      supervisorUserAccountId: ACCOUNT_ID,
    });
    expect(storage.createReadUrl).toHaveBeenCalledWith({
      objectKey: 'attendance/selfie-accepted/review-scope',
      expiresInSeconds: 60,
    });
  });

  it('does not sign a Supervisor selfie URL when the repository denies the assigned-store scope', async () => {
    const { service, repository, storage } = harness();
    const attemptId = '00000000-0000-4000-8000-000000000055';
    const findAttached = vi
      .spyOn(repository, 'findAttachedObjectForAttempt')
      .mockResolvedValue(null);

    await expect(
      service.createReviewReadUrl(principal(UserRole.SUPERVISOR), attemptId),
    ).rejects.toMatchObject({ statusCode: 404, code: 'SELFIE_NOT_FOUND' });

    expect(findAttached).toHaveBeenCalledWith({
      attemptId,
      now: NOW,
      supervisorUserAccountId: ACCOUNT_ID,
    });
    expect(storage.createReadUrl).not.toHaveBeenCalled();
  });

  it('caps signed read URLs at the configured TTL and never signs at the retention boundary', async () => {
    const { service, repository, storage } = harness();
    repository.attached.push({
      referenceHash: '1'.repeat(64),
      attemptId: '00000000-0000-4000-8000-000000000056',
      objectKey: 'attendance/selfie-accepted/ttl-cap',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() + 121_000),
    });
    repository.attached.push({
      referenceHash: '2'.repeat(64),
      attemptId: '00000000-0000-4000-8000-000000000057',
      objectKey: 'attendance/selfie-accepted/retention-boundary',
      contentType: 'image/jpeg',
      retentionExpiresAt: NOW,
    });

    const signed = await service.createReadUrl(
      principal(UserRole.ADMIN),
      '00000000-0000-4000-8000-000000000056',
    );
    expect(signed.expiresAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(storage.createReadUrl).toHaveBeenCalledWith({
      objectKey: 'attendance/selfie-accepted/ttl-cap',
      expiresInSeconds: 120,
    });

    vi.mocked(storage.createReadUrl).mockClear();
    await expect(
      service.createReadUrl(principal(UserRole.ADMIN), '00000000-0000-4000-8000-000000000057'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'SELFIE_NOT_FOUND' });
    expect(storage.createReadUrl).not.toHaveBeenCalled();
  });

  it('purges expired attached photos and abandoned staging uploads idempotently', async () => {
    const { service, repository, storage } = harness();
    const receipt = await service.createUploadIntent(principal(), INPUT);
    const pending = [...repository.rows.values()][0]!;
    repository.rows.set(pending.referenceHash, {
      ...pending,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    repository.attached.push({
      referenceHash: 'e'.repeat(64),
      attemptId: '00000000-0000-4000-8000-000000000053',
      objectKey: 'attendance/selfie-accepted/expired',
      stagingObjectKey: 'attendance/selfie-staging/accepted-expired',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() - 1),
    });

    const first = await service.purgeExpiredBatch(100, NOW);
    const retry = await service.purgeExpiredBatch(100, NOW);

    expect(first).toEqual({ attachedPurged: 1, stagingPurged: 2, failures: 0 });
    expect(retry).toEqual({ attachedPurged: 0, stagingPurged: 0, failures: 0 });
    expect(storage.deleteObject).toHaveBeenCalledTimes(4);
    expect(repository.rows.has(pending.referenceHash)).toBe(false);
    expect(repository.attached).toHaveLength(0);
    expect(receipt.referenceId).toBeTruthy();
  });

  it('keeps metadata for retry if object deletion fails and safely succeeds on the next run', async () => {
    let failOnce = true;
    const storageDelete = vi.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw new AppError(503, 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE', 'Unavailable');
      }
    });
    const { service, repository, storage } = harness();
    // Swap in a failing idempotent storage deletion implementation for this scenario.
    vi.mocked(storage.deleteObject).mockImplementation(storageDelete);
    repository.attached.push({
      referenceHash: 'f'.repeat(64),
      attemptId: '00000000-0000-4000-8000-000000000054',
      objectKey: 'attendance/selfie-accepted/retry',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date(NOW.getTime() - 1),
    });

    expect(await service.purgeExpiredBatch(100, NOW)).toMatchObject({ failures: 1 });
    expect(repository.attached).toHaveLength(1);
    expect(await service.purgeExpiredBatch(100, NOW)).toEqual({
      attachedPurged: 1,
      stagingPurged: 0,
      failures: 0,
    });
    expect(repository.attached).toHaveLength(0);
  });

  it('keeps a claimed expired upload for retry after a partial storage cleanup failure', async () => {
    let failOnce = true;
    const { service, repository, storage } = harness();
    vi.mocked(storage.deleteObject).mockImplementation(async () => {
      if (failOnce) {
        failOnce = false;
        throw new AppError(503, 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE', 'Unavailable');
      }
    });
    const receipt = await service.createUploadIntent(principal(), INPUT);
    const intent = [...repository.rows.values()][0]!;
    repository.rows.set(intent.referenceHash, {
      ...intent,
      expiresAt: new Date(NOW.getTime() - 1),
    });

    expect(await service.purgeExpiredBatch(100, NOW)).toMatchObject({ failures: 1 });
    expect(repository.rows.has(intent.referenceHash)).toBe(true);
    expect(repository.purgeClaims.has(intent.referenceHash)).toBe(true);

    expect(await service.purgeExpiredBatch(100, NOW)).toEqual({
      attachedPurged: 0,
      stagingPurged: 1,
      failures: 0,
    });
    expect(repository.rows.has(intent.referenceHash)).toBe(false);
    expect(repository.purgeClaims.has(intent.referenceHash)).toBe(false);
    expect(receipt.referenceId).toBeTruthy();
    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
  });
});
