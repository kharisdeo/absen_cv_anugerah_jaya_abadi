import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type {
  CreatePendingSelfieUploadIntentData,
  PendingSelfieUploadIntent,
  SelfieUploadIntentRepository,
} from '../../src/modules/attendance/selfie-upload.js';
import { SelfieUploadService } from '../../src/modules/attendance/selfie-upload.js';
import type { PrivateSelfieStorage } from '../../src/modules/attendance/private-selfie-storage.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000041';
const ORIGIN = 'http://localhost:5173';
const openApps: FastifyInstance[] = [];

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: `00000000-0000-4000-8000-${role === UserRole.EMPLOYEE ? '000000000042' : role === UserRole.ADMIN ? '000000000043' : '000000000044'}`,
    username: role.toLowerCase(),
    role,
    employeeId: EMPLOYEE_ID,
    deviceBindingStatus: DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): AuthenticatedSession {
  const user = publicUser(role);
  return {
    user,
    principal: {
      userAccountId: user.id,
      role,
      username: user.username,
      employeeId: EMPLOYEE_ID,
      deviceBindingId: '00000000-0000-4000-8000-000000000045',
      deviceBindingStatus: DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `selfie-upload-session-${role}`,
      lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
    },
  };
}

class MemoryIntentRepository implements SelfieUploadIntentRepository {
  readonly rows = new Map<string, PendingSelfieUploadIntent>();
  readonly attached: Array<{
    attemptId: string;
    objectKey: string;
    contentType: string;
    retentionExpiresAt: Date;
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
    return row &&
      row.employeeId === input.employeeId &&
      row.deviceBindingId === input.deviceBindingId
      ? row
      : null;
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

  async listAttachedStaging() {
    return [];
  }

  async clearAttachedStaging() {
    return false;
  }

  async listExpiredAttached() {
    return [];
  }

  async markAttachedObjectPurged() {
    return false;
  }

  async claimExpiredPending() {
    return [];
  }

  async deleteExpiredPending() {
    return false;
  }
}

async function makeHarness(options: { rateLimit?: { max: number; timeWindow: string } } = {}) {
  const repository = new MemoryIntentRepository();
  const storage: PrivateSelfieStorage = {
    createUploadUrl: vi.fn(async ({ objectKey }) => ({
      url: `https://private-storage.example/${objectKey}?signed=true`,
      headers: { 'Content-Type': 'image/jpeg', 'x-amz-meta-referencehash': 'private-hash' },
    })),
    inspectObject: vi.fn(async () => null),
    sealObject: vi.fn(async () => {}),
    createReadUrl: vi.fn(async () => 'https://private-storage.example/signed-get?signature=true'),
    deleteObject: vi.fn(async () => {}),
  };
  const service = new SelfieUploadService(repository, storage, 120);
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((candidate) => candidate === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `selfie-upload-route-${role}`;
      sessions.set(token, session(role));
      return { cookieToken: token, user: publicUser(role) };
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
    cookieSecret: 'selfie-upload-route-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({
    logger: false,
    auth,
    attendanceSelfieUploads: { service },
  });
  openApps.push(app);
  return { app, repository, storage };
}

async function login(app: FastifyInstance, role: UserRole): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { identifier: role, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(';', 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('POST /api/v1/attendance/selfie-upload-intents', () => {
  it('requires a session and exact Origin and never caches signed upload responses', async () => {
    const { app } = await makeHarness();
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/selfie-upload-intents',
      headers: { origin: ORIGIN },
      payload: { contentType: 'image/jpeg', sizeBytes: 1024 },
    });
    const cookie = await login(app, UserRole.EMPLOYEE);
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/selfie-upload-intents',
      headers: { cookie },
      payload: { contentType: 'image/jpeg', sizeBytes: 1024 },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(csrf.statusCode).toBe(403);
    expect(csrf.headers['cache-control']).toBe('no-store');
  });

  it('returns an employee-only, no-store intent at the exact API route', async () => {
    const { app, repository } = await makeHarness();
    const adminCookie = await login(app, UserRole.ADMIN);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/selfie-upload-intents',
      headers: { origin: ORIGIN, cookie: adminCookie },
      payload: { contentType: 'image/jpeg', sizeBytes: 1024 },
    });
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/selfie-upload-intents',
      headers: { origin: ORIGIN, cookie: employeeCookie },
      payload: { contentType: 'image/jpeg', sizeBytes: 1024 },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      referenceId: expect.any(String),
      uploadUrl: expect.stringContaining('https://private-storage.example/'),
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
      expiresAt: expect.any(String),
    });
    expect(response.json()).not.toHaveProperty('objectKey');
    expect(repository.rows.size).toBe(1);
  });

  it('rejects oversized and unsupported media metadata without creating an intent', async () => {
    const { app, repository } = await makeHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    for (const payload of [
      { contentType: 'image/gif', sizeBytes: 1024 },
      { contentType: 'image/jpeg', sizeBytes: 204_801 },
      { contentType: 'image/jpeg', sizeBytes: 1024, objectKey: 'attacker/key' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/selfie-upload-intents',
        headers: { origin: ORIGIN, cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_SELFIE_UPLOAD_INTENT' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(repository.rows.size).toBe(0);
  });

  it('applies sensitive rate limits to signed URL minting', async () => {
    const { app } = await makeHarness({ rateLimit: { max: 1, timeWindow: '1 minute' } });
    const cookie = await login(app, UserRole.EMPLOYEE);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/attendance/selfie-upload-intents',
        headers: { origin: ORIGIN, cookie },
        payload: { contentType: 'image/jpeg', sizeBytes: 1024 },
      });
    const first = await send();
    const limited = await send();

    expect(first.statusCode).toBe(201);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/v1/admin/attendance-attempts/:attemptId/selfie-url', () => {
  it('only lets Admin mint a short-lived private read URL and prevents caching', async () => {
    const { app, repository, storage } = await makeHarness();
    const attemptId = '00000000-0000-4000-8000-000000000046';
    repository.attached.push({
      attemptId,
      objectKey: 'attendance/selfie-accepted/opaque-key',
      contentType: 'image/jpeg',
      retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const employeeResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/attendance-attempts/${attemptId}/selfie-url`,
      headers: { cookie: employeeCookie },
    });
    const adminCookie = await login(app, UserRole.ADMIN);
    const adminResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/attendance-attempts/${attemptId}/selfie-url`,
      headers: { cookie: adminCookie },
    });

    expect(employeeResponse.statusCode).toBe(403);
    expect(employeeResponse.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(employeeResponse.headers['cache-control']).toBe('no-store');
    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.headers['cache-control']).toBe('no-store');
    expect(adminResponse.json()).toMatchObject({
      url: expect.stringContaining('https://private-storage.example/signed-get'),
      expiresAt: expect.any(String),
    });
    expect(storage.createReadUrl).toHaveBeenCalledWith({
      objectKey: 'attendance/selfie-accepted/opaque-key',
      expiresInSeconds: 120,
    });
    expect(storage.createReadUrl).toHaveBeenCalledTimes(1);
  });
});
