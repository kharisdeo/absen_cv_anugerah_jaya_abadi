import { createHash } from 'node:crypto';

import {
  type AttendanceType,
  type AttendanceAttemptProcessingStatus,
  type AttendanceValidationStatus,
  type NetworkStatus,
  type ValidationMethod,
} from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import { getBusinessDateAndWeekday } from '../time/index.js';
import { z } from 'zod';
import { assertAttendanceEmployeeActor, type AttendanceAttemptActor } from './authorization.js';
import { attendanceBusinessRuleErrorFromCode } from './business-rules.js';

const referenceId = z.string().uuid();
const uuid = z.string().uuid();

function hasAtMostDecimalPlaces(value: number, places: number): boolean {
  return Number(value.toFixed(places)) === value;
}

const clientRecordedAt = z.string().superRefine((value, context) => {
  try {
    getBusinessDateAndWeekday(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Timestamp harus ISO-8601 valid dengan offset zona.',
    });
  }
});

const attendanceAttemptBodySchema = z
  .object({
    idempotencyKey: uuid,
    /** Optional, untrusted choice. The server resolves it against active assignments. */
    storeId: uuid.optional(),
    type: z.enum(['CHECK_IN', 'CHECK_OUT']),
    clientRecordedAt,
    networkStatus: z.enum(['ONLINE', 'OFFLINE']),
    location: z
      .object({
        latitude: z
          .number()
          .min(-90)
          .max(90)
          .refine((value) => hasAtMostDecimalPlaces(value, 6)),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .refine((value) => hasAtMostDecimalPlaces(value, 6)),
        accuracyMeters: z
          .number()
          .positive()
          .max(999_999.99)
          .refine((value) => hasAtMostDecimalPlaces(value, 2)),
      })
      .strict(),
    validationMethod: z.enum(['GPS', 'QR', 'WIFI', 'SUPERVISOR', 'OFFLINE', 'ASSISTED']),
    selfie: z
      .object({
        /** Random private-upload reference UUID; never an image, URL, or bearer token. */
        blob: referenceId,
        sizeKb: z.number().int().min(1).max(200),
      })
      .strict(),
    liveness: z
      .object({
        /** Client claims retained for later review; neither field is a server validation. */
        faceDetected: z.boolean(),
        passed: z.boolean(),
      })
      .strict(),
    proofCode: z.null().optional(),
  })
  .strict();

export type AttendanceAttemptBody = z.infer<typeof attendanceAttemptBodySchema>;
export { attendanceAttemptBodySchema };

export type AttendanceAttemptRecord = Readonly<{
  id: string;
  employeeId: string;
  deviceBindingId: string;
  type: AttendanceType;
  idempotencyKey: string;
  requestFingerprint: string;
  deviceIdHash: string;
  receivedAt: Date;
  processingStatus: AttendanceAttemptProcessingStatus;
  processingErrorCode: string | null;
  attendanceId: string | null;
  attendanceValidationStatus: AttendanceValidationStatus | null;
}>;

export type { AttendanceAttemptActor } from './authorization.js';

export type AttendanceAttemptAuditContext = Readonly<{
  actor: AttendanceAttemptActor;
  clientIp: string | null;
  requestId: string;
}>;

export type CreateAttendanceAttemptData = Readonly<{
  actor: AttendanceAttemptActor;
  idempotencyKey: string;
  requestFingerprint: string;
  storeIdHint: string | null;
  type: AttendanceType;
  clientRecordedAt: Date;
  networkStatus: NetworkStatus;
  reportedMethod: ValidationMethod;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  selfieReferenceHash: string;
  selfieStagedObjectKey: string;
  selfieSealedObjectKey: string;
  selfieSizeBytes: number;
  selfieRetentionExpiresAt: Date;
  livenessFaceDetectedClaim: boolean;
  livenessPassedClaim: boolean;
  clientIp: string | null;
  requestId: string;
}>;

export interface AttendanceAttemptRepository {
  findByIdempotencyKey(
    employeeId: string,
    idempotencyKey: string,
  ): Promise<AttendanceAttemptRecord | null>;
  createAttempt(
    data: CreateAttendanceAttemptData,
  ): Promise<Readonly<{ record: AttendanceAttemptRecord; created: boolean }>>;
}

export type VerifiedSelfieReference = Readonly<{
  sizeBytes: number;
  stagedObjectKey: string;
  sealedObjectKey: string;
}>;

/**
 * Must check that the reference identifies a private image staged for this employee/device.
 * The endpoint fails closed until BE-015 provides the storage-backed implementation.
 */
export interface AttendanceEvidenceReferenceVerifier {
  verifyPrivateSelfieReference(
    input: Readonly<{
      referenceId: string;
      employeeId: string;
      deviceBindingId: string;
    }>,
  ): Promise<VerifiedSelfieReference>;
}

export type AttendanceAttemptContext = Readonly<{
  clientIp?: string;
  requestId: string;
}>;

export type AttendanceAttemptReceipt = Readonly<{
  attemptId: string;
  state: 'RECEIVED' | 'RECORDED';
  type: AttendanceType;
  receivedAt: string;
  replayed: boolean;
  attendanceId?: string;
  validationStatus?: AttendanceValidationStatus;
}>;

function invalidEvidence(): AppError {
  return new AppError(422, 'ATTENDANCE_EVIDENCE_INVALID', 'Referensi bukti absensi tidak valid.');
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'Kunci idempotensi sudah dipakai untuk isi permintaan yang berbeda.',
  );
}

function selfieReferenceHash(referenceId: string): string {
  return createHash('sha256').update(referenceId, 'utf8').digest('hex');
}

function fingerprint(input: AttendanceAttemptBody, referenceHash: string): string {
  const canonicalRequest = {
    type: input.type,
    storeIdHint: input.storeId ?? null,
    clientRecordedAt: new Date(input.clientRecordedAt).toISOString(),
    networkStatus: input.networkStatus,
    location: {
      latitude: input.location.latitude,
      longitude: input.location.longitude,
      accuracyMeters: input.location.accuracyMeters,
    },
    validationMethod: input.validationMethod,
    selfieReferenceHash: referenceHash,
    selfieSizeKb: input.selfie.sizeKb,
    liveness: {
      faceDetected: input.liveness.faceDetected,
      passed: input.liveness.passed,
    },
  };

  return createHash('sha256').update(JSON.stringify(canonicalRequest), 'utf8').digest('hex');
}

export class AttendanceAttemptService {
  constructor(
    private readonly repository: AttendanceAttemptRepository,
    private readonly evidenceVerifier: AttendanceEvidenceReferenceVerifier,
    private readonly retentionMonths = 12,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(retentionMonths) || retentionMonths < 1) {
      throw new RangeError('Selfie retention months must be a positive integer.');
    }
  }

  async createAttempt(
    principal: AuthPrincipal,
    input: AttendanceAttemptBody,
    context: AttendanceAttemptContext,
  ): Promise<AttendanceAttemptReceipt> {
    const actor = assertAttendanceEmployeeActor(principal);
    const referenceHash = selfieReferenceHash(input.selfie.blob);
    const requestFingerprint = fingerprint(input, referenceHash);
    const existing = await this.repository.findByIdempotencyKey(
      actor.employeeId,
      input.idempotencyKey,
    );

    if (existing) return this.toReceipt(existing, actor, requestFingerprint, true);

    let verifiedReference: VerifiedSelfieReference;
    try {
      verifiedReference = await this.evidenceVerifier.verifyPrivateSelfieReference({
        referenceId: input.selfie.blob,
        employeeId: actor.employeeId,
        deviceBindingId: actor.deviceBindingId,
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'ATTENDANCE_EVIDENCE_INVALID' ||
          error.code === 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE')
      ) {
        throw error;
      }
      throw new AppError(
        503,
        'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
        'Validasi bukti absensi sementara tidak tersedia. Coba lagi nanti.',
      );
    }

    if (
      !Number.isInteger(verifiedReference.sizeBytes) ||
      verifiedReference.sizeBytes < 1 ||
      verifiedReference.sizeBytes > 200 * 1024 ||
      Math.ceil(verifiedReference.sizeBytes / 1024) !== input.selfie.sizeKb
    ) {
      throw invalidEvidence();
    }

    const result = await this.repository.createAttempt({
      actor,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      storeIdHint: input.storeId ?? null,
      type: input.type,
      clientRecordedAt: new Date(input.clientRecordedAt),
      networkStatus: input.networkStatus,
      reportedMethod: input.validationMethod,
      latitude: input.location.latitude,
      longitude: input.location.longitude,
      accuracyMeters: input.location.accuracyMeters,
      selfieReferenceHash: referenceHash,
      selfieStagedObjectKey: verifiedReference.stagedObjectKey,
      selfieSealedObjectKey: verifiedReference.sealedObjectKey,
      selfieSizeBytes: verifiedReference.sizeBytes,
      selfieRetentionExpiresAt: addUtcMonths(this.now(), this.retentionMonths),
      livenessFaceDetectedClaim: input.liveness.faceDetected,
      livenessPassedClaim: input.liveness.passed,
      clientIp: context.clientIp ?? null,
      requestId: context.requestId,
    });

    return this.toReceipt(result.record, actor, requestFingerprint, !result.created);
  }

  private toReceipt(
    record: AttendanceAttemptRecord,
    actor: AttendanceAttemptActor,
    requestFingerprint: string,
    replayed: boolean,
  ): AttendanceAttemptReceipt {
    if (
      record.employeeId !== actor.employeeId ||
      record.deviceBindingId !== actor.deviceBindingId ||
      record.requestFingerprint !== requestFingerprint
    ) {
      throw idempotencyConflict();
    }

    if (record.processingStatus === 'RULE_REJECTED') {
      const error = attendanceBusinessRuleErrorFromCode(record.processingErrorCode);
      if (error) throw error;
      throw new AppError(
        409,
        'ATTENDANCE_ATTEMPT_RULE_REJECTED',
        'Percobaan absensi ditolak oleh aturan shift. Ajukan koreksi absensi.',
      );
    }

    return {
      attemptId: record.id,
      state: record.processingStatus === 'RECORDED' ? 'RECORDED' : 'RECEIVED',
      type: record.type,
      receivedAt: record.receivedAt.toISOString(),
      replayed,
      ...(record.attendanceId ? { attendanceId: record.attendanceId } : {}),
      ...(record.attendanceValidationStatus
        ? { validationStatus: record.attendanceValidationStatus }
        : {}),
    };
  }
}

/** Add calendar months without overflowing short months (e.g. Jan 31 → Feb 28/29). */
export function addUtcMonths(date: Date, months: number): Date {
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(months) || months < 1) {
    throw new RangeError('A valid date and positive integer month count are required.');
  }
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export class UnavailableAttendanceEvidenceVerifier implements AttendanceEvidenceReferenceVerifier {
  async verifyPrivateSelfieReference(): Promise<never> {
    throw new AppError(
      503,
      'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
      'Validasi bukti absensi belum tersedia. Percobaan belum disimpan.',
    );
  }
}

export type { GeofenceResult } from './geospatial-validation.js';
export {
  assessOfflineSyncTime,
  DEVICE_TIME_DRIFT_LIMIT_MS,
  OFFLINE_SYNC_MAX_AGE_MS,
  type OfflineSyncTimeAssessment,
} from './offline-sync.js';
