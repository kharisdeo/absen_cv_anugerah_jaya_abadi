import { describe, expect, it, vi } from 'vitest';

import { DeviceBindingStatus, NetworkStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  addUtcMonths,
  AttendanceAttemptService,
  UnavailableAttendanceEvidenceVerifier,
  attendanceAttemptBodySchema,
  type AttendanceAttemptBody,
  type AttendanceAttemptRecord,
  type AttendanceAttemptRepository,
  type CreateAttendanceAttemptData,
} from '../../src/modules/attendance/index.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';
const BINDING_ID = '00000000-0000-4000-8000-000000000003';
const KEY = '00000000-0000-4000-8000-000000000004';
const RECEIVED_AT = new Date('2026-10-11T03:00:00.000Z');

function payload(overrides: Partial<AttendanceAttemptBody> = {}): AttendanceAttemptBody {
  return {
    idempotencyKey: KEY,
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    networkStatus: 'ONLINE',
    location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12.5 },
    validationMethod: 'GPS',
    selfie: { blob: '00000000-0000-4000-8000-000000000005', sizeKb: 10 },
    liveness: { faceDetected: true, passed: true },
    proofCode: null,
    ...overrides,
  };
}

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
    sessionId: 'test-session',
    lastSeenAt: RECEIVED_AT,
  };
}

class MemoryAttendanceAttemptRepository implements AttendanceAttemptRepository {
  readonly records: AttendanceAttemptRecord[] = [];
  readonly createCalls: CreateAttendanceAttemptData[] = [];

  async findByIdempotencyKey(employeeId: string, idempotencyKey: string) {
    return (
      this.records.find(
        (record) => record.employeeId === employeeId && record.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async createAttempt(data: CreateAttendanceAttemptData) {
    this.createCalls.push(data);
    // No async gap between checking and inserting: this fake models an atomic unique index.
    const existing =
      this.records.find(
        (record) =>
          record.employeeId === data.actor.employeeId &&
          record.idempotencyKey === data.idempotencyKey,
      ) ?? null;
    if (existing) return { record: existing, created: false } as const;

    const record: AttendanceAttemptRecord = {
      id: `00000000-0000-4000-8000-${String(this.records.length + 100).padStart(12, '0')}`,
      employeeId: data.actor.employeeId,
      deviceBindingId: data.actor.deviceBindingId,
      type: data.type,
      idempotencyKey: data.idempotencyKey,
      requestFingerprint: data.requestFingerprint,
      deviceIdHash: 'server-derived-hash',
      receivedAt: RECEIVED_AT,
      processingStatus: data.locationFailureReason ? 'RECEIVED' : 'RECORDED',
      processingErrorCode: null,
      locationFailureReason: data.locationFailureReason,
      attendanceId: data.locationFailureReason ? null : '00000000-0000-4000-8000-000000000099',
      attendanceValidationStatus: data.locationFailureReason ? null : 'PENDING_VERIFICATION',
    };
    this.records.push(record);
    return { record, created: true } as const;
  }
}

function serviceHarness(
  verifier: ConstructorParameters<typeof AttendanceAttemptService>[1] = {
    async verifyPrivateSelfieReference() {
      return {
        sizeBytes: 10 * 1024,
        stagedObjectKey: 'attendance/selfie-staging/test',
        sealedObjectKey: 'attendance/selfie-accepted/test',
      };
    },
  },
) {
  const repository = new MemoryAttendanceAttemptRepository();
  return { repository, service: new AttendanceAttemptService(repository, verifier) };
}

describe('attendance attempt contract', () => {
  it('calculates a calendar retention deadline without overflowing short months', () => {
    expect(addUtcMonths(new Date('2024-01-31T12:34:56.000Z'), 1)).toEqual(
      new Date('2024-02-29T12:34:56.000Z'),
    );
    expect(addUtcMonths(new Date('2026-10-11T03:00:00.000Z'), 12)).toEqual(
      new Date('2027-10-11T03:00:00.000Z'),
    );
  });

  it('rejects Supervisor and Admin explicitly even when employee and approved-device fields exist', async () => {
    const { repository, service } = serviceHarness();

    for (const role of [UserRole.SUPERVISOR, UserRole.ADMIN]) {
      await expect(
        service.createAttempt(principal(role), payload(), { requestId: 'request-1' }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    }

    expect(repository.records).toHaveLength(0);
    expect(repository.createCalls).toHaveLength(0);
  });

  it('requires the session-derived approved device binding before creating an attempt', async () => {
    const { repository, service } = serviceHarness();
    const unbound = {
      ...principal(),
      deviceBindingId: null,
      deviceBindingStatus: null,
    } satisfies AuthPrincipal;

    await expect(
      service.createAttempt(unbound, payload(), { requestId: 'request-unbound' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ATTENDANCE_DEVICE_BINDING_REQUIRED' });
    expect(repository.records).toHaveLength(0);
  });

  it('strictly rejects identity, server-owned, status, store, distance, and device fields', () => {
    const forbiddenFields = [
      'employeeId',
      'serverTime',
      'status',
      'validationStatus',
      'distanceMeters',
      'geofenceResult',
      'deviceId',
    ];

    for (const field of forbiddenFields) {
      expect(
        attendanceAttemptBodySchema.safeParse({ ...payload(), [field]: 'forged' }).success,
      ).toBe(false);
    }
    expect(
      attendanceAttemptBodySchema.safeParse({ ...payload(), proofCode: 'forged' }).success,
    ).toBe(false);
  });

  it('requires a bounded location failure reason only when no fix is available', () => {
    expect(
      attendanceAttemptBodySchema.safeParse({
        ...payload(),
        location: null,
        locationFailureReason: 'PERMISSION_DENIED',
      }).success,
    ).toBe(true);
    expect(attendanceAttemptBodySchema.safeParse({ ...payload(), location: null }).success).toBe(
      false,
    );
    expect(
      attendanceAttemptBodySchema.safeParse({
        ...payload(),
        locationFailureReason: 'TIMEOUT',
      }).success,
    ).toBe(false);
    expect(
      attendanceAttemptBodySchema.safeParse({
        ...payload(),
        location: null,
        locationFailureReason: 'CLIENT_CLAIMS_VALID',
      }).success,
    ).toBe(false);
  });

  it('accepts an optional store choice only as a server-validated assignment hint', async () => {
    const { repository, service } = serviceHarness();
    const storeIdHint = '00000000-0000-4000-8000-000000000006';

    await service.createAttempt(principal(), payload({ storeId: storeIdHint }), {
      requestId: 'request-store-hint',
    });

    expect(repository.createCalls[0]?.storeIdHint).toBe(storeIdHint);
    expect(
      attendanceAttemptBodySchema.safeParse({ ...payload(), storeId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects malformed UUID, timestamp, enums, ranges, and nested unknown fields', () => {
    const valid = payload();
    const invalidCases = [
      { ...valid, idempotencyKey: 'not-a-uuid' },
      { ...valid, clientRecordedAt: '2026-02-30T10:00:00+07:00' },
      { ...valid, clientRecordedAt: '2026-10-11T10:00:00' },
      { ...valid, type: 'ARRIVE' },
      { ...valid, networkStatus: 'CONNECTED' },
      { ...valid, validationMethod: 'FACE' },
      { ...valid, location: { ...valid.location, latitude: 91 } },
      { ...valid, location: { ...valid.location, altitude: 10 } },
      { ...valid, selfie: { ...valid.selfie, blob: 'https://public.example/image.jpg' } },
      { ...valid, liveness: { ...valid.liveness, confidence: 1 } },
    ];

    for (const invalid of invalidCases) {
      expect(attendanceAttemptBodySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('returns a receipt for the first create and the same receipt for an idempotent retry', async () => {
    const verify = vi.fn(async () => ({
      sizeBytes: 10 * 1024,
      stagedObjectKey: 'attendance/selfie-staging/test',
      sealedObjectKey: 'attendance/selfie-accepted/test',
    }));
    const { repository, service } = serviceHarness({ verifyPrivateSelfieReference: verify });
    const first = await service.createAttempt(principal(), payload(), { requestId: 'request-1' });
    const retry = await service.createAttempt(principal(), payload(), { requestId: 'request-2' });

    expect(first).toMatchObject({
      state: 'RECORDED',
      attendanceId: '00000000-0000-4000-8000-000000000099',
      validationStatus: 'PENDING_VERIFICATION',
      replayed: false,
    });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(repository.records).toHaveLength(1);
    expect(repository.createCalls).toHaveLength(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('retries watermarking on an exact idempotent attempt and never invokes it for a conflicting replay', async () => {
    const watermark = vi.fn(async () => {});
    const { repository, service } = serviceHarness({
      async verifyPrivateSelfieReference() {
        return {
          sizeBytes: 10 * 1024,
          stagedObjectKey: 'attendance/selfie-staging/watermark',
          sealedObjectKey: 'attendance/selfie-accepted/watermark',
        };
      },
      applyWatermarkForAttempt: watermark,
    });
    const first = await service.createAttempt(principal(), payload(), {
      requestId: 'watermark-first',
    });
    await service.createAttempt(principal(), payload(), { requestId: 'watermark-retry' });

    await expect(
      service.createAttempt(principal(), payload({ type: 'CHECK_OUT' }), {
        requestId: 'watermark-conflict',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.records).toHaveLength(1);
    expect(watermark).toHaveBeenNthCalledWith(1, first.attemptId);
    expect(watermark).toHaveBeenNthCalledWith(2, first.attemptId);
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it('keeps a persisted receipt retryable when watermark rendering fails', async () => {
    let failOnce = true;
    const watermark = vi.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw new AppError(503, 'SELFIE_WATERMARK_UNAVAILABLE', 'Watermark unavailable.');
      }
    });
    const { repository, service } = serviceHarness({
      async verifyPrivateSelfieReference() {
        return {
          sizeBytes: 10 * 1024,
          stagedObjectKey: 'attendance/selfie-staging/retry',
          sealedObjectKey: 'attendance/selfie-accepted/retry',
        };
      },
      applyWatermarkForAttempt: watermark,
    });

    await expect(
      service.createAttempt(principal(), payload(), { requestId: 'watermark-failed' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SELFIE_WATERMARK_UNAVAILABLE' });
    expect(repository.records).toHaveLength(1);
    const retry = await service.createAttempt(principal(), payload(), {
      requestId: 'watermark-retry',
    });
    expect(retry).toMatchObject({ replayed: true, state: 'RECORDED' });
    expect(repository.createCalls).toHaveLength(1);
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it('stores a no-fix attempt as RECEIVED without claiming Attendance, and scopes replay', async () => {
    const { repository, service } = serviceHarness();
    const noFix = payload({ location: null, locationFailureReason: 'TIMEOUT' });

    const first = await service.createAttempt(principal(), noFix, { requestId: 'gps-fail-1' });
    const replay = await service.createAttempt(principal(), noFix, { requestId: 'gps-fail-2' });

    expect(first).toMatchObject({
      state: 'RECEIVED',
      locationFailureReason: 'TIMEOUT',
      replayed: false,
    });
    expect(first).not.toHaveProperty('attendanceId');
    expect(first).not.toHaveProperty('validationStatus');
    expect(replay).toEqual({ ...first, replayed: true });
    expect(repository.records).toHaveLength(1);
    expect(repository.createCalls[0]).toMatchObject({
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      locationFailureReason: 'TIMEOUT',
    });

    const anotherDevice = {
      ...principal(),
      deviceBindingId: '00000000-0000-4000-8000-000000000006',
    } satisfies AuthPrincipal;
    await expect(
      service.createAttempt(anotherDevice, noFix, { requestId: 'gps-fail-foreign-device' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.records).toHaveLength(1);
  });

  it('accepts an offline queued attempt through the existing immutable receipt path', async () => {
    const { repository, service } = serviceHarness();
    const offlinePayload = payload({ networkStatus: NetworkStatus.OFFLINE });

    const first = await service.createAttempt(principal(), offlinePayload, {
      requestId: 'offline-request-1',
    });
    const retry = await service.createAttempt(principal(), offlinePayload, {
      requestId: 'offline-request-2',
    });

    expect(repository.records).toHaveLength(1);
    expect(repository.createCalls).toHaveLength(1);
    expect(repository.createCalls[0]).toMatchObject({
      networkStatus: NetworkStatus.OFFLINE,
      clientRecordedAt: new Date(offlinePayload.clientRecordedAt),
    });
    expect(retry).toEqual({ ...first, replayed: true });
  });

  it('does not replay an offline receipt across a different device binding', async () => {
    const { repository, service } = serviceHarness();
    const offlinePayload = payload({ networkStatus: NetworkStatus.OFFLINE });
    await service.createAttempt(principal(), offlinePayload, { requestId: 'offline-device-1' });
    const anotherDevice = {
      ...principal(),
      deviceBindingId: '00000000-0000-4000-8000-000000000006',
    } satisfies AuthPrincipal;

    await expect(
      service.createAttempt(anotherDevice, offlinePayload, { requestId: 'offline-device-2' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.records).toHaveLength(1);
    expect(repository.createCalls).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key for a different payload without storing a second row', async () => {
    const { repository, service } = serviceHarness();
    await service.createAttempt(principal(), payload(), { requestId: 'request-1' });

    await expect(
      service.createAttempt(
        principal(),
        payload({ location: { latitude: -6.21, longitude: 106.8, accuracyMeters: 12.5 } }),
        { requestId: 'request-2' },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.records).toHaveLength(1);
  });

  it('includes the untrusted store choice in the idempotency fingerprint', async () => {
    const { repository, service } = serviceHarness();
    await service.createAttempt(principal(), payload(), { requestId: 'request-1' });

    await expect(
      service.createAttempt(
        principal(),
        payload({ storeId: '00000000-0000-4000-8000-000000000006' }),
        { requestId: 'request-2' },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.records).toHaveLength(1);
  });

  it('fails closed on unavailable or mismatched private selfie verification', async () => {
    const unavailable = serviceHarness(new UnavailableAttendanceEvidenceVerifier());
    await expect(
      unavailable.service.createAttempt(principal(), payload(), { requestId: 'request-1' }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    });
    expect(unavailable.repository.records).toHaveLength(0);

    const mismatched = serviceHarness({
      async verifyPrivateSelfieReference() {
        return {
          sizeBytes: 9 * 1024,
          stagedObjectKey: 'attendance/selfie-staging/test',
          sealedObjectKey: 'attendance/selfie-accepted/test',
        };
      },
    });
    await expect(
      mismatched.service.createAttempt(principal(), payload(), { requestId: 'request-2' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'ATTENDANCE_EVIDENCE_INVALID' });
    expect(mismatched.repository.records).toHaveLength(0);
  });

  it('uses the repository unique-key winner for simultaneous requests', async () => {
    const repository = new MemoryAttendanceAttemptRepository();
    let enteredVerifiers = 0;
    let releaseVerifiers!: () => void;
    const bothVerifying = new Promise<void>((resolve) => {
      releaseVerifiers = resolve;
    });
    const service = new AttendanceAttemptService(repository, {
      async verifyPrivateSelfieReference() {
        enteredVerifiers += 1;
        if (enteredVerifiers === 2) releaseVerifiers();
        await bothVerifying;
        return {
          sizeBytes: 10 * 1024,
          stagedObjectKey: 'attendance/selfie-staging/test',
          sealedObjectKey: 'attendance/selfie-accepted/test',
        };
      },
    });

    const receipts = await Promise.all([
      service.createAttempt(principal(), payload(), { requestId: 'race-1' }),
      service.createAttempt(principal(), payload(), { requestId: 'race-2' }),
    ]);

    expect(repository.records).toHaveLength(1);
    expect(repository.createCalls).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(receipts[0]?.attemptId).toBe(receipts[1]?.attemptId);
  });

  it('does not expose trusted actor identifiers or raw selfie reference in the receipt', async () => {
    const { service } = serviceHarness();
    const receipt = await service.createAttempt(principal(), payload(), { requestId: 'request-1' });

    expect(receipt).toEqual({
      attemptId: expect.any(String),
      state: 'RECORDED',
      type: 'CHECK_IN',
      receivedAt: RECEIVED_AT.toISOString(),
      replayed: false,
      attendanceId: '00000000-0000-4000-8000-000000000099',
      validationStatus: 'PENDING_VERIFICATION',
    });
    expect(JSON.stringify(receipt)).not.toContain(EMPLOYEE_ID);
    expect(JSON.stringify(receipt)).not.toContain('00000000-0000-4000-8000-000000000005');
  });
});
