import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type {
  AttendanceAttemptRecord,
  AttendanceAttemptRepository,
  CreateAttendanceAttemptData,
} from '../../src/modules/attendance/index.js';
import {
  AttendanceAttemptService,
  UnavailableAttendanceEvidenceVerifier,
} from '../../src/modules/attendance/index.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';
import { MAX_ATTENDANCE_ATTEMPT_BODY_BYTES } from '../../src/routes/attendance-attempts.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000011';
const SECOND_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000020';
const SECOND_EMPLOYEE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000021';
const ORIGIN = 'http://localhost:5173';
const openApps: FastifyInstance[] = [];

function publicUser(
  role: UserRole,
  employeeId = EMPLOYEE_ID,
  userAccountId?: string,
): PublicAuthUser {
  const accountId =
    userAccountId ??
    (role === UserRole.EMPLOYEE
      ? '00000000-0000-4000-8000-000000000012'
      : role === UserRole.SUPERVISOR
        ? '00000000-0000-4000-8000-000000000013'
        : '00000000-0000-4000-8000-000000000014');
  return {
    id: accountId,
    username: role.toLowerCase(),
    role,
    employeeId,
    deviceBindingStatus: DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(
  role: UserRole,
  employeeId = EMPLOYEE_ID,
  userAccountId?: string,
): AuthenticatedSession {
  const user = publicUser(role, employeeId, userAccountId);
  return {
    user,
    principal: {
      userAccountId: user.id,
      role,
      username: user.username,
      employeeId,
      deviceBindingId: '00000000-0000-4000-8000-000000000015',
      deviceBindingStatus: DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `attendance-attempt-session-${role}`,
      lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
    },
  };
}

function requestBody() {
  return {
    idempotencyKey: '00000000-0000-4000-8000-000000000016',
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    networkStatus: 'ONLINE',
    location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12.5 },
    validationMethod: 'GPS',
    selfie: { blob: '00000000-0000-4000-8000-000000000017', sizeKb: 10 },
    liveness: { faceDetected: true, passed: true },
    proofCode: null,
  };
}

class RouteMemoryRepository implements AttendanceAttemptRepository {
  readonly records: AttendanceAttemptRecord[] = [];
  readonly creates: CreateAttendanceAttemptData[] = [];

  async findByIdempotencyKey(employeeId: string, idempotencyKey: string) {
    return (
      this.records.find(
        (record) => record.employeeId === employeeId && record.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async createAttempt(data: CreateAttendanceAttemptData) {
    this.creates.push(data);
    const existing = await this.findByIdempotencyKey(data.actor.employeeId, data.idempotencyKey);
    if (existing) return { record: existing, created: false } as const;

    const recordNumber = this.records.length;
    const record: AttendanceAttemptRecord = {
      id: `00000000-0000-4000-8000-${String(18 + recordNumber).padStart(12, '0')}`,
      employeeId: data.actor.employeeId,
      deviceBindingId: data.actor.deviceBindingId,
      type: data.type,
      idempotencyKey: data.idempotencyKey,
      requestFingerprint: data.requestFingerprint,
      deviceIdHash: 'server-derived-device-hash',
      receivedAt: new Date('2026-10-11T03:00:00.000Z'),
      processingStatus: data.locationFailureReason ? 'RECEIVED' : 'RECORDED',
      processingErrorCode: null,
      locationFailureReason: data.locationFailureReason,
      attendanceId: data.locationFailureReason
        ? null
        : `00000000-0000-4000-8000-${String(19 + recordNumber).padStart(12, '0')}`,
      attendanceValidationStatus: data.locationFailureReason ? null : 'PENDING_VERIFICATION',
    };
    this.records.push(record);
    return { record, created: true } as const;
  }
}

async function makeHarness(
  options: {
    verifier?: ConstructorParameters<typeof AttendanceAttemptService>[1];
    sensitiveRateLimit?: Readonly<{ max: number; timeWindow: string }>;
  } = {},
) {
  const repository = new RouteMemoryRepository();
  const verifier = options.verifier ?? {
    async verifyPrivateSelfieReference() {
      return {
        sizeBytes: 10 * 1024,
        stagedObjectKey: 'attendance/selfie-staging/test',
        sealedObjectKey: 'attendance/selfie-accepted/test',
      };
    },
  };
  const service = new AttendanceAttemptService(repository, verifier);
  const sessions = new Map<string, AuthenticatedSession>();
  let nextSessionNumber = 0;
  const authService = {
    async login(input: { identifier: string }) {
      const role =
        input.identifier === 'employee-2'
          ? UserRole.EMPLOYEE
          : Object.values(UserRole).find((candidate) => candidate === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const isSecondEmployee = input.identifier === 'employee-2';
      const authenticated = session(
        role,
        isSecondEmployee ? SECOND_EMPLOYEE_ID : EMPLOYEE_ID,
        isSecondEmployee ? SECOND_EMPLOYEE_ACCOUNT_ID : undefined,
      );
      const token = `attendance-attempt-route-${input.identifier}-${++nextSessionNumber}`;
      sessions.set(token, authenticated);
      return { cookieToken: token, user: authenticated.user };
    },
    async authenticate(token: string | undefined) {
      const authenticated = token ? sessions.get(token) : undefined;
      if (!authenticated) throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid.');
      return authenticated;
    },
    requireRegularAccess() {},
  } as unknown as AuthRoutesOptions['service'];
  const auth = {
    service: authService,
    cookieSecret: 'attendance-attempt-route-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: options.sensitiveRateLimit ?? { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({ logger: false, auth, attendanceAttempts: { service } });
  openApps.push(app);
  return { app, repository };
}

async function login(app: FastifyInstance, role: UserRole | 'employee-2'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { identifier: role, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  expect(cookie).toBeTruthy();
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(';', 1)[0]!;
}

async function postAttempt(app: FastifyInstance, cookie: string, body: object = requestBody()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/attendance/attempts',
    headers: { origin: ORIGIN, cookie },
    payload: body,
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('POST /api/v1/attendance/attempts', () => {
  it('requires a session and exact Origin, and marks denied responses no-store', async () => {
    const { app } = await makeHarness();
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: { origin: ORIGIN },
      payload: requestBody(),
    });
    const cookie = await login(app, UserRole.EMPLOYEE);
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: { cookie },
      payload: requestBody(),
    });
    const foreignOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: { cookie, origin: 'https://attacker.example.test' },
      payload: requestBody(),
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
    expect(csrf.headers['cache-control']).toBe('no-store');
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
    expect(
      Object.keys(foreignOrigin.headers).filter((name) => name.startsWith('access-control-allow-')),
    ).toHaveLength(0);
  });

  it('allows only EMPLOYEE and rejects Supervisor/Admin even with a bound device', async () => {
    const { app, repository } = await makeHarness();
    for (const role of [UserRole.SUPERVISOR, UserRole.ADMIN]) {
      const cookie = await login(app, role);
      const response = await postAttempt(app, cookie);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(repository.records).toHaveLength(0);
  });

  it('creates a receipt once and replays the same receipt for a duplicate request', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const first = await postAttempt(app, cookie);
    const retry = await postAttempt(app, cookie);

    expect(first.statusCode).toBe(202);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toMatchObject({
      state: 'RECORDED',
      replayed: false,
      attendanceId: '00000000-0000-4000-8000-000000000019',
      validationStatus: 'PENDING_VERIFICATION',
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['cache-control']).toBe('no-store');
    expect(retry.json()).toEqual({ ...first.json(), replayed: true });
    expect(repository.records).toHaveLength(1);
    expect(repository.creates).toHaveLength(1);
    expect(Object.keys(first.json()).sort()).toEqual(
      [
        'attemptId',
        'attendanceId',
        'receivedAt',
        'replayed',
        'state',
        'type',
        'validationStatus',
      ].sort(),
    );
    const responseBody = JSON.stringify(first.json());
    for (const privateSentinel of [
      requestBody().idempotencyKey,
      requestBody().location.latitude.toString(),
      requestBody().location.longitude.toString(),
      requestBody().selfie.blob,
      EMPLOYEE_ID,
      '00000000-0000-4000-8000-000000000012',
      'server-derived-device-hash',
      'synthetic-raw-selfie-bytes-sentinel',
      'https://private-storage.example/signed-selfie-sentinel?token=synthetic',
    ]) {
      expect(responseBody).not.toContain(privateSentinel);
    }
  });

  it('replays across sessions for the same employee but never crosses employee ownership', async () => {
    const { app, repository } = await makeHarness();
    const employeeSessionOne = await login(app, UserRole.EMPLOYEE);
    const first = await postAttempt(app, employeeSessionOne);
    const employeeSessionTwo = await login(app, UserRole.EMPLOYEE);
    const sameOwnerReplay = await postAttempt(app, employeeSessionTwo);
    const otherEmployee = await login(app, 'employee-2');
    const isolatedAttempt = await postAttempt(app, otherEmployee);

    expect(first.statusCode).toBe(202);
    expect(sameOwnerReplay.statusCode).toBe(200);
    expect(sameOwnerReplay.json()).toEqual({ ...first.json(), replayed: true });
    expect(isolatedAttempt.statusCode).toBe(202);
    expect(isolatedAttempt.json()).toMatchObject({ replayed: false });
    expect(isolatedAttempt.json()).not.toEqual({ ...first.json(), replayed: true });
    expect(isolatedAttempt.json().attendanceId).not.toBe(first.json().attendanceId);
    expect(repository.records).toHaveLength(2);
    expect(repository.records.map((record) => record.employeeId)).toEqual([
      EMPLOYEE_ID,
      SECOND_EMPLOYEE_ID,
    ]);
    expect(repository.creates).toHaveLength(2);
  });

  it('accepts and idempotently replays an offline queued attempt', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const offlineBody = { ...requestBody(), networkStatus: 'OFFLINE' };

    const first = await postAttempt(app, cookie, offlineBody);
    const retry = await postAttempt(app, cookie, offlineBody);

    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), replayed: true });
    expect(repository.records).toHaveLength(1);
    expect(repository.creates).toHaveLength(1);
    expect(repository.creates[0]?.networkStatus).toBe('OFFLINE');
  });

  it('returns an owner-scoped RECEIVED receipt for a no-fix location attempt', async () => {
    const { app, repository } = await makeHarness();
    const ownerCookie = await login(app, UserRole.EMPLOYEE);
    const noFixBody = {
      ...requestBody(),
      location: null,
      locationFailureReason: 'POSITION_UNAVAILABLE',
    };

    const first = await postAttempt(app, ownerCookie, noFixBody);
    const replay = await postAttempt(app, ownerCookie, noFixBody);
    const otherEmployeeCookie = await login(app, 'employee-2');
    const isolated = await postAttempt(app, otherEmployeeCookie, noFixBody);

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      state: 'RECEIVED',
      locationFailureReason: 'POSITION_UNAVAILABLE',
      replayed: false,
    });
    expect(first.json()).not.toHaveProperty('attendanceId');
    expect(first.json()).not.toHaveProperty('validationStatus');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(isolated.statusCode).toBe(202);
    expect(isolated.json()).toMatchObject({ replayed: false, state: 'RECEIVED' });
    expect(isolated.json().attemptId).not.toBe(first.json().attemptId);
    expect(repository.records).toHaveLength(2);
    expect(repository.records.map((record) => record.employeeId)).toEqual([
      EMPLOYEE_ID,
      SECOND_EMPLOYEE_ID,
    ]);
  });

  it('rejects reuse of an offline idempotency key with a different payload', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const offlineBody = { ...requestBody(), networkStatus: 'OFFLINE' };
    const first = await postAttempt(app, cookie, offlineBody);
    const conflicting = await postAttempt(app, cookie, {
      ...offlineBody,
      location: { ...offlineBody.location, latitude: -6.21 },
    });

    expect(first.statusCode).toBe(202);
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.records).toHaveLength(1);
    expect(repository.creates).toHaveLength(1);
  });

  it('does not expose employee update or delete endpoints for submitted attempts', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const created = await postAttempt(app, cookie, {
      ...requestBody(),
      networkStatus: 'OFFLINE',
    });
    const attendanceId = created.json<{ attendanceId: string }>().attendanceId;

    for (const method of ['PATCH', 'DELETE'] as const) {
      const mutation = await app.inject({
        method,
        url: `/api/v1/attendance/attempts/${attendanceId}`,
        headers: { origin: ORIGIN, cookie },
        payload: { status: 'VALID' },
      });
      expect(mutation.statusCode).toBe(404);
    }
    expect(repository.records).toHaveLength(1);
    expect(repository.creates).toHaveLength(1);
  });

  it('treats an optional storeId as an untrusted assignment hint', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const storeIdHint = '00000000-0000-4000-8000-000000000019';
    const response = await postAttempt(app, cookie, { ...requestBody(), storeId: storeIdHint });

    expect(response.statusCode).toBe(202);
    expect(repository.creates[0]?.storeIdHint).toBe(storeIdHint);
    expect(response.json()).not.toHaveProperty('storeId');
    expect(response.json()).not.toHaveProperty('distanceMeters');
  });

  it('rejects strict/forbidden fields and malformed payloads without persisting', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const invalidBodies = [
      { ...requestBody(), employeeId: EMPLOYEE_ID },
      { ...requestBody(), serverTime: '2026-10-11T03:00:00Z' },
      { ...requestBody(), status: 'VALID' },
      { ...requestBody(), distanceMeters: 1 },
      { ...requestBody(), geofenceResult: 'WITHIN_LIMITS' },
      { ...requestBody(), storeId: 'not-a-uuid' },
      { ...requestBody(), deviceId: 'raw-client-device-id' },
      { ...requestBody(), idempotencyKey: 'not-a-uuid' },
      { ...requestBody(), clientRecordedAt: 'not-a-timestamp' },
      { ...requestBody(), type: 'IN' },
      { ...requestBody(), proofCode: 'client-proof' },
    ];

    for (const invalid of invalidBodies) {
      const response = await postAttempt(app, cookie, invalid);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_ATTENDANCE_ATTEMPT' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(repository.records).toHaveLength(0);
  });

  it('enforces the request body limit and does not store an oversized payload', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const payload = JSON.stringify({
      ...requestBody(),
      padding: 'x'.repeat(MAX_ATTENDANCE_ATTEMPT_BODY_BYTES),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      payload,
    });

    expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_ATTENDANCE_ATTEMPT_BODY_BYTES);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.records).toHaveLength(0);
  });

  it('exposes the sensitive rate limit with a safe error code', async () => {
    const { app } = await makeHarness({
      sensitiveRateLimit: { max: 1, timeWindow: '1 minute' },
    });
    const cookie = await login(app, UserRole.EMPLOYEE);
    const first = await postAttempt(app, cookie);
    const limited = await postAttempt(app, cookie);

    expect(first.statusCode).toBe(202);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('fails closed if the private selfie verifier is unavailable and still sets no-store', async () => {
    const { app, repository } = await makeHarness({
      verifier: new UnavailableAttendanceEvidenceVerifier(),
    });
    const cookie = await login(app, UserRole.EMPLOYEE);
    const response = await postAttempt(app, cookie);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.records).toHaveLength(0);
  });
});
