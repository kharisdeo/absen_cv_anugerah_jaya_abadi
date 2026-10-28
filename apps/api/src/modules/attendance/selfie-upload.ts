import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '../../errors/app-error.js';
import { UserRole } from '../../generated/prisma/enums.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import { assertAttendanceEmployeeActor } from './authorization.js';
import { renderWatermarkedSelfie } from './selfie-watermark.js';
import type { AttendanceEvidenceReferenceVerifier, VerifiedSelfieReference } from './index.js';
import type { PrivateSelfieStorage, SignedSelfieUpload } from './private-selfie-storage.js';

const MAX_SELFIE_SIZE_BYTES = 200 * 1024;
const allowedContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const selfieUploadIntentBodySchema = z
  .object({
    contentType: z.enum(allowedContentTypes),
    sizeBytes: z.number().int().min(1).max(MAX_SELFIE_SIZE_BYTES),
  })
  .strict();

export type SelfieUploadIntentBody = z.infer<typeof selfieUploadIntentBodySchema>;

export type CreatePendingSelfieUploadIntentData = Readonly<{
  referenceHash: string;
  employeeId: string;
  deviceBindingId: string;
  objectKey: string;
  sealedObjectKey: string;
  contentType: (typeof allowedContentTypes)[number];
  declaredSizeBytes: number;
  expiresAt: Date;
}>;

export type PendingSelfieUploadIntent = CreatePendingSelfieUploadIntentData;

export type SelfieWatermarkSource = Readonly<{
  referenceHash: string;
  objectKey: string;
  watermarkedObjectKey: string;
  watermarkApplied: boolean;
  contentType: string;
  sizeBytes: number;
  retentionExpiresAt: Date;
  watermarkMetadata: unknown;
}>;

export interface SelfieUploadIntentRepository {
  createPending(data: CreatePendingSelfieUploadIntentData): Promise<void>;
  findPendingForVerification(
    input: Readonly<{
      referenceHash: string;
      employeeId: string;
      deviceBindingId: string;
      now: Date;
    }>,
  ): Promise<PendingSelfieUploadIntent | null>;
  findAttachedObjectForAttempt(
    input: Readonly<{
      attemptId: string;
      now: Date;
      supervisorUserAccountId?: string;
    }>,
  ): Promise<Readonly<{
    objectKey: string;
    contentType: string;
    retentionExpiresAt: Date;
    watermarkApplied: boolean;
  }> | null>;
  reserveWatermarkedObjectForAttempt(
    input: Readonly<{
      attemptId: string;
      candidateObjectKey: string;
      now: Date;
    }>,
  ): Promise<SelfieWatermarkSource | null>;
  markWatermarkApplied(
    input: Readonly<{
      attemptId: string;
      referenceHash: string;
      originalObjectKey: string;
      watermarkedObjectKey: string;
      sizeBytes: number;
      now: Date;
    }>,
  ): Promise<boolean>;
  listPendingWatermarkAttempts(
    input: Readonly<{ now: Date; take: number }>,
  ): Promise<readonly string[]>;
  previewRetentionCandidates(input: Readonly<{ now: Date; take: number }>): Promise<
    Readonly<{
      watermarkCandidates: number;
      attachedStagingCandidates: number;
      expiredAttachedCandidates: number;
      expiredPendingCandidates: number;
      batchLimitHit: Readonly<{
        watermark: boolean;
        attachedStaging: boolean;
        expiredAttached: boolean;
        expiredPending: boolean;
      }>;
    }>
  >;
  listAttachedStaging(
    input: Readonly<{ take: number }>,
  ): Promise<readonly Readonly<{ referenceHash: string; stagingObjectKey: string }>[]>;
  clearAttachedStaging(
    input: Readonly<{
      referenceHash: string;
      stagingObjectKey: string;
    }>,
  ): Promise<boolean>;
  listExpiredAttached(input: Readonly<{ now: Date; take: number }>): Promise<
    readonly Readonly<{
      referenceHash: string;
      objectKey: string;
      watermarkedObjectKey: string | null;
      attachedAttemptId: string | null;
    }>[]
  >;
  markAttachedObjectPurged(
    input: Readonly<{
      referenceHash: string;
      objectKey: string;
      watermarkedObjectKey: string | null;
      attachedAttemptId: string | null;
      deletedAt: Date;
    }>,
  ): Promise<boolean>;
  claimExpiredPending(
    input: Readonly<{ now: Date; take: number }>,
  ): Promise<
    readonly Readonly<{ referenceHash: string; objectKey: string; sealedObjectKey: string }>[]
  >;
  deleteExpiredPending(
    input: Readonly<{
      referenceHash: string;
      objectKey: string;
      now: Date;
    }>,
  ): Promise<boolean>;
}

export type SelfieUploadIntentReceipt = Readonly<{
  referenceId: string;
  uploadUrl: string;
  requiredHeaders: SignedSelfieUpload['headers'];
  expiresAt: string;
}>;

export type SignedSelfieReadReceipt = Readonly<{ url: string; expiresAt: string }>;
export type SelfieRetentionBatchResult = Readonly<{
  attachedPurged: number;
  stagingPurged: number;
  failures: number;
}>;
export type SelfieRetentionPreview = Readonly<{
  previewedAt: string;
  batchSize: number;
  watermarkCandidates: number;
  attachedStagingCandidates: number;
  expiredAttachedCandidates: number;
  expiredPendingCandidates: number;
  batchLimitHit: Readonly<{
    watermark: boolean;
    attachedStaging: boolean;
    expiredAttached: boolean;
    expiredPending: boolean;
  }>;
}>;
export type SelfieWatermarkBatchResult = Readonly<{ watermarked: number; failures: number }>;

function invalidEvidence(): AppError {
  return new AppError(422, 'ATTENDANCE_EVIDENCE_INVALID', 'Referensi bukti absensi tidak valid.');
}

function unavailable(): AppError {
  return new AppError(
    503,
    'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    'Penyimpanan bukti absensi sementara tidak tersedia. Coba lagi nanti.',
  );
}

function imageTypeMatches(contentType: string, imageType: string | undefined): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return imageType === 'jpg';
    case 'image/png':
      return imageType === 'png';
    case 'image/webp':
      return imageType === 'webp';
    default:
      return false;
  }
}

function isValidPrivateImage(
  object: Awaited<ReturnType<PrivateSelfieStorage['inspectObject']>>,
  referenceHash: string,
  contentType: string,
  sizeBytes: number,
): object is NonNullable<Awaited<ReturnType<PrivateSelfieStorage['inspectObject']>>> {
  return Boolean(
    object &&
    object.referenceHash === referenceHash &&
    object.contentType === contentType &&
    object.sizeBytes === sizeBytes &&
    object.sizeBytes >= 1 &&
    object.sizeBytes <= MAX_SELFIE_SIZE_BYTES &&
    imageTypeMatches(object.contentType, object.imageType) &&
    Number.isSafeInteger(object.width) &&
    Number.isSafeInteger(object.height) &&
    (object.width ?? 0) >= 1 &&
    (object.height ?? 0) >= 1 &&
    Boolean(object.entityTag) &&
    object.bytes instanceof Uint8Array &&
    object.bytes.byteLength === object.sizeBytes,
  );
}

export class SelfieUploadService implements AttendanceEvidenceReferenceVerifier {
  constructor(
    private readonly repository: SelfieUploadIntentRepository,
    private readonly storage: PrivateSelfieStorage,
    private readonly uploadUrlTtlSeconds = 120,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isInteger(uploadUrlTtlSeconds) ||
      uploadUrlTtlSeconds < 30 ||
      uploadUrlTtlSeconds > 300
    ) {
      throw new RangeError('Selfie upload URL TTL must be between 30 and 300 seconds.');
    }
  }

  async createUploadIntent(
    principal: AuthPrincipal,
    input: SelfieUploadIntentBody,
  ): Promise<SelfieUploadIntentReceipt> {
    const actor = assertAttendanceEmployeeActor(principal);
    const referenceId = randomUUID();
    const referenceHash = createHash('sha256').update(referenceId, 'utf8').digest('hex');
    const objectKey = `attendance/selfie-staging/${randomUUID()}`;
    const sealedObjectKey = `attendance/selfie-accepted/${randomUUID()}`;
    const expiresAt = new Date(this.now().getTime() + this.uploadUrlTtlSeconds * 1000);

    let signed: SignedSelfieUpload;
    try {
      signed = await this.storage.createUploadUrl({
        objectKey,
        contentType: input.contentType,
        referenceHash,
        expiresInSeconds: this.uploadUrlTtlSeconds,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }

    await this.repository.createPending({
      referenceHash,
      employeeId: actor.employeeId,
      deviceBindingId: actor.deviceBindingId,
      objectKey,
      sealedObjectKey,
      contentType: input.contentType,
      declaredSizeBytes: input.sizeBytes,
      expiresAt,
    });

    return {
      referenceId,
      uploadUrl: signed.url,
      requiredHeaders: signed.headers,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyPrivateSelfieReference(
    input: Readonly<{
      referenceId: string;
      employeeId: string;
      deviceBindingId: string;
    }>,
  ): Promise<VerifiedSelfieReference> {
    const referenceHash = createHash('sha256').update(input.referenceId, 'utf8').digest('hex');
    const intent = await this.repository.findPendingForVerification({
      referenceHash,
      employeeId: input.employeeId,
      deviceBindingId: input.deviceBindingId,
      now: this.now(),
    });
    if (!intent) throw invalidEvidence();

    let object;
    try {
      object = await this.storage.inspectObject(intent.objectKey);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    if (!isValidPrivateImage(object, referenceHash, intent.contentType, intent.declaredSizeBytes)) {
      throw invalidEvidence();
    }

    try {
      await this.storage.sealObject({
        sealedObjectKey: intent.sealedObjectKey,
        bytes: object.bytes!,
        contentType: object.contentType,
        referenceHash,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ATTENDANCE_EVIDENCE_INVALID') {
        if (error instanceof AppError) throw error;
        throw unavailable();
      }

      // A previous concurrent/retried attempt may already have created the
      // destination. Reuse it only if its metadata and actual bytes remain valid;
      // the destination is never signed for client writes.
      let existingSealedObject;
      try {
        existingSealedObject = await this.storage.inspectObject(intent.sealedObjectKey);
      } catch (inspectError) {
        if (inspectError instanceof AppError) throw inspectError;
        throw unavailable();
      }
      if (
        !isValidPrivateImage(
          existingSealedObject,
          referenceHash,
          intent.contentType,
          intent.declaredSizeBytes,
        )
      ) {
        throw invalidEvidence();
      }
    }

    return {
      sizeBytes: object.sizeBytes,
      stagedObjectKey: intent.objectKey,
      sealedObjectKey: intent.sealedObjectKey,
    };
  }

  async applyWatermarkForAttempt(attemptId: string): Promise<void> {
    let source: SelfieWatermarkSource | null;
    try {
      source = await this.repository.reserveWatermarkedObjectForAttempt({
        attemptId,
        candidateObjectKey: `attendance/selfie-watermarked/${randomUUID()}`,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    if (!source)
      throw new AppError(
        503,
        'SELFIE_WATERMARK_UNAVAILABLE',
        'Watermark bukti selfie belum tersedia. Coba lagi nanti.',
      );
    if (source.watermarkApplied) return;

    let original;
    try {
      original = await this.storage.inspectObject(source.objectKey);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    if (
      !isValidPrivateImage(original, source.referenceHash, source.contentType, source.sizeBytes) ||
      !source.watermarkMetadata ||
      typeof source.watermarkMetadata !== 'object' ||
      Array.isArray(source.watermarkMetadata)
    ) {
      throw new AppError(
        503,
        'SELFIE_WATERMARK_UNAVAILABLE',
        'Metadata bukti selfie tidak dapat diverifikasi.',
      );
    }

    let derivative: Buffer;
    try {
      derivative = await renderWatermarkedSelfie(
        original.bytes!,
        source.contentType,
        source.watermarkMetadata as Parameters<typeof renderWatermarkedSelfie>[2],
      );
    } catch {
      throw new AppError(
        503,
        'SELFIE_WATERMARK_UNAVAILABLE',
        'Watermark bukti selfie gagal dibuat. Coba lagi nanti.',
      );
    }

    try {
      await this.storage.sealObject({
        sealedObjectKey: source.watermarkedObjectKey,
        bytes: derivative,
        contentType: 'image/jpeg',
        referenceHash: source.referenceHash,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ATTENDANCE_EVIDENCE_INVALID') {
        if (error instanceof AppError) throw error;
        throw unavailable();
      }

      // Another retry may have completed the same reserved immutable derivative.
      let existing;
      try {
        existing = await this.storage.inspectObject(source.watermarkedObjectKey);
      } catch (inspectError) {
        if (inspectError instanceof AppError) throw inspectError;
        throw unavailable();
      }
      if (
        !existing ||
        existing.referenceHash !== source.referenceHash ||
        existing.contentType !== 'image/jpeg' ||
        existing.sizeBytes < 1 ||
        existing.sizeBytes > MAX_SELFIE_SIZE_BYTES ||
        existing.imageType !== 'jpg' ||
        !existing.bytes ||
        existing.bytes.byteLength !== existing.sizeBytes
      ) {
        throw new AppError(
          503,
          'SELFIE_WATERMARK_UNAVAILABLE',
          'Turunan watermark yang tersimpan tidak valid.',
        );
      }
      derivative = Buffer.from(existing.bytes);
    }

    try {
      const marked = await this.repository.markWatermarkApplied({
        attemptId,
        referenceHash: source.referenceHash,
        originalObjectKey: source.objectKey,
        watermarkedObjectKey: source.watermarkedObjectKey,
        sizeBytes: derivative.byteLength,
        now: this.now(),
      });
      if (!marked) throw new Error('Watermark state was not committed');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'SELFIE_WATERMARK_UNAVAILABLE',
        'Status watermark belum tersimpan. Coba lagi nanti.',
      );
    }
  }

  async watermarkPendingBatch(
    batchSize = 100,
    now = this.now(),
  ): Promise<SelfieWatermarkBatchResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new RangeError('Watermark batch size must be between 1 and 500.');
    }
    const attempts = await this.repository.listPendingWatermarkAttempts({ now, take: batchSize });
    let watermarked = 0;
    let failures = 0;
    for (const attemptId of attempts) {
      try {
        await this.applyWatermarkForAttempt(attemptId);
        watermarked += 1;
      } catch {
        failures += 1;
      }
    }
    return { watermarked, failures };
  }

  async previewRetentionCandidates(
    batchSize = 500,
    now = this.now(),
  ): Promise<SelfieRetentionPreview> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new RangeError('Retention preview batch size must be between 1 and 500.');
    }
    const candidates = await this.repository.previewRetentionCandidates({ now, take: batchSize });
    return { previewedAt: now.toISOString(), batchSize, ...candidates };
  }

  async createReadUrl(
    principal: AuthPrincipal,
    attemptId: string,
  ): Promise<SignedSelfieReadReceipt> {
    if (principal.role !== UserRole.ADMIN) {
      throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat membuka bukti selfie.');
    }
    let now = this.now();
    const attached = await this.findWatermarkedObjectForRead({ attemptId, now });
    now = this.now();
    const remainingRetentionSeconds = Math.floor(
      (attached.retentionExpiresAt.getTime() - now.getTime()) / 1000,
    );
    if (remainingRetentionSeconds < 1) {
      throw new AppError(404, 'SELFIE_NOT_FOUND', 'Bukti selfie tidak ditemukan.');
    }
    const ttlSeconds = Math.min(this.uploadUrlTtlSeconds, remainingRetentionSeconds);

    let url: string;
    try {
      url = await this.storage.createReadUrl({
        objectKey: attached.objectKey,
        expiresInSeconds: ttlSeconds,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    return { url, expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
  }

  /** Review reads allow Supervisors only through a repository-enforced assigned-store scope. */
  async createReviewReadUrl(
    principal: AuthPrincipal,
    attemptId: string,
  ): Promise<SignedSelfieReadReceipt> {
    if (principal.role !== UserRole.ADMIN && principal.role !== UserRole.SUPERVISOR) {
      throw new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses ke bukti selfie absensi.');
    }
    let now = this.now();
    const attached = await this.findWatermarkedObjectForRead({
      attemptId,
      now,
      ...(principal.role === UserRole.SUPERVISOR
        ? { supervisorUserAccountId: principal.userAccountId }
        : {}),
    });
    now = this.now();
    const remainingRetentionSeconds = Math.floor(
      (attached.retentionExpiresAt.getTime() - now.getTime()) / 1000,
    );
    if (remainingRetentionSeconds < 1) {
      throw new AppError(404, 'SELFIE_NOT_FOUND', 'Bukti selfie tidak ditemukan.');
    }

    const ttlSeconds = Math.min(this.uploadUrlTtlSeconds, remainingRetentionSeconds);
    try {
      const url = await this.storage.createReadUrl({
        objectKey: attached.objectKey,
        expiresInSeconds: ttlSeconds,
      });
      return { url, expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }

  private async findWatermarkedObjectForRead(input: {
    attemptId: string;
    now: Date;
    supervisorUserAccountId?: string;
  }) {
    let attached = await this.repository.findAttachedObjectForAttempt(input);
    if (!attached) {
      throw new AppError(404, 'SELFIE_NOT_FOUND', 'Bukti selfie tidak ditemukan.');
    }
    if (!attached.watermarkApplied) {
      await this.applyWatermarkForAttempt(input.attemptId);
      attached = await this.repository.findAttachedObjectForAttempt(input);
    }
    if (!attached?.watermarkApplied) {
      throw new AppError(
        503,
        'SELFIE_WATERMARK_UNAVAILABLE',
        'Bukti selfie ber-watermark belum tersedia.',
      );
    }
    return attached;
  }

  async purgeExpiredBatch(batchSize = 100, now = this.now()): Promise<SelfieRetentionBatchResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new RangeError('Retention batch size must be between 1 and 500.');
    }

    let attachedPurged = 0;
    let stagingPurged = 0;
    let failures = 0;

    const attachedStaging = await this.repository.listAttachedStaging({ take: batchSize });
    for (const selfie of attachedStaging) {
      try {
        await this.storage.deleteObject(selfie.stagingObjectKey);
        if (
          await this.repository.clearAttachedStaging({
            referenceHash: selfie.referenceHash,
            stagingObjectKey: selfie.stagingObjectKey,
          })
        ) {
          stagingPurged += 1;
        }
      } catch {
        failures += 1;
      }
    }

    const expiredAttached = await this.repository.listExpiredAttached({ now, take: batchSize });
    for (const selfie of expiredAttached) {
      try {
        await this.storage.deleteObject(selfie.objectKey);
        if (selfie.watermarkedObjectKey) {
          await this.storage.deleteObject(selfie.watermarkedObjectKey);
        }
        if (
          await this.repository.markAttachedObjectPurged({
            referenceHash: selfie.referenceHash,
            objectKey: selfie.objectKey,
            watermarkedObjectKey: selfie.watermarkedObjectKey,
            attachedAttemptId: selfie.attachedAttemptId,
            deletedAt: now,
          })
        ) {
          attachedPurged += 1;
        }
      } catch {
        failures += 1;
      }
    }

    const expiredStaging = await this.repository.claimExpiredPending({ now, take: batchSize });
    for (const selfie of expiredStaging) {
      try {
        await this.storage.deleteObject(selfie.objectKey);
        await this.storage.deleteObject(selfie.sealedObjectKey);
        if (
          await this.repository.deleteExpiredPending({
            referenceHash: selfie.referenceHash,
            objectKey: selfie.objectKey,
            now,
          })
        ) {
          stagingPurged += 1;
        }
      } catch {
        failures += 1;
      }
    }

    return { attachedPurged, stagingPurged, failures };
  }
}

export class UnavailableSelfieUploadIntentRepository implements SelfieUploadIntentRepository {
  async createPending(): Promise<never> {
    throw unavailable();
  }

  async findPendingForVerification(): Promise<never> {
    throw unavailable();
  }

  async reserveWatermarkedObjectForAttempt(): Promise<never> {
    throw unavailable();
  }

  async markWatermarkApplied(): Promise<never> {
    throw unavailable();
  }

  async listPendingWatermarkAttempts(): Promise<never> {
    throw unavailable();
  }

  async previewRetentionCandidates(): Promise<never> {
    throw unavailable();
  }

  async findAttachedObjectForAttempt(): Promise<never> {
    throw unavailable();
  }

  async listAttachedStaging(): Promise<never> {
    throw unavailable();
  }

  async clearAttachedStaging(): Promise<never> {
    throw unavailable();
  }

  async listExpiredAttached(): Promise<never> {
    throw unavailable();
  }

  async markAttachedObjectPurged(): Promise<never> {
    throw unavailable();
  }

  async claimExpiredPending(): Promise<never> {
    throw unavailable();
  }

  async deleteExpiredPending(): Promise<never> {
    throw unavailable();
  }
}
