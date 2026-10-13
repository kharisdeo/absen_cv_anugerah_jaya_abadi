import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';
import {
  createFakeDeviceBindingService,
  FakeDeviceBindingRepository,
} from '../helpers/fake-device-binding.js';

const ADMIN_ACCOUNT_ID = '7ea98c5d-7f3a-4b9f-8dca-3d4d8fd71210';
const EMPLOYEE_ACCOUNT_ID = 'b7fd4072-f499-4cd4-959a-730f9f037801';
const EMPLOYEE_PROFILE_ID = '3ddac739-8bdf-43e8-82f3-5067bb3ed4f1';
const PENDING_BINDING_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_BINDING_ID = '00000000-0000-4000-8000-000000000002';
const ORIGIN = 'http://localhost:5173';
const NOW = new Date('2026-10-11T03:15:00.000Z');
const HASH_SENTINEL = 'a'.repeat(64);

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function publicUser(role: UserRole): PublicAuthUser {
  const isAdmin = role === UserRole.ADMIN;
  return {
    id: isAdmin ? ADMIN_ACCOUNT_ID : EMPLOYEE_ACCOUNT_ID,
    username: isAdmin ? 'admin' : 'employee',
    role,
    employeeId: isAdmin ? null : EMPLOYEE_PROFILE_ID,
    deviceBindingStatus: isAdmin ? null : DeviceBindingStatus.APPROVED,
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
      employeeId: user.employeeId,
      deviceBindingId: role === UserRole.ADMIN ? null : SECOND_BINDING_ID,
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `test-session-${role}`,
      lastSeenAt: NOW,
    },
  };
}

async function makeHarness(
  options: {
    onboardingBlocked?: boolean;
    sensitiveRateLimit?: Readonly<{ max: number; timeWindow: string }>;
  } = {},
) {
  const repository = new FakeDeviceBindingRepository();
  const events: RecordAuditEventInput[] = [];
  const service = createFakeDeviceBindingService(
    repository,
    {
      async record(event) {
        events.push(event);
        return {} as never;
      },
    },
    () => new Date(NOW),
  );
  const first = await repository.enroll({
    employeeId: EMPLOYEE_PROFILE_ID,
    deviceIdHash: HASH_SENTINEL,
    deviceName: 'Android kasir',
    requestedAt: NOW,
  });
  expect(first.binding.id).toBe(PENDING_BINDING_ID);
  await repository.enroll({
    employeeId: EMPLOYEE_PROFILE_ID,
    deviceIdHash: 'b'.repeat(64),
    deviceName: 'Android pengganti',
    requestedAt: new Date(NOW.getTime() + 1),
  });
  const sessions = new Map<string, AuthenticatedSession>();
  let onboardingBlocked = options.onboardingBlocked ?? false;
  const authService = {
    async login(input: { identifier: string }) {
      const role = input.identifier === 'admin' ? UserRole.ADMIN : UserRole.EMPLOYEE;
      const cookieToken = `route-test-token-${role}`;
      sessions.set(cookieToken, session(role));
      return { cookieToken, user: publicUser(role) };
    },
    async authenticate(token: string | undefined) {
      const authenticated = token ? sessions.get(token) : undefined;
      if (!authenticated) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      }
      return authenticated;
    },
    requireRegularAccess() {
      if (onboardingBlocked) {
        throw new AppError(403, 'ONBOARDING_REQUIRED', 'Selesaikan onboarding terlebih dahulu.');
      }
    },
  } as unknown as AuthRoutesOptions['service'];
  const auth = {
    service: authService,
    cookieSecret: 'device-binding-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: options.sensitiveRateLimit ?? { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({
    logger: false,
    auth,
    deviceBindings: { service },
  });
  openApps.push(app);

  return {
    app,
    repository,
    events,
    setOnboardingBlocked(value: boolean) {
      onboardingBlocked = value;
    },
  };
}

async function login(app: FastifyInstance, role: UserRole): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: {
      identifier: role === UserRole.ADMIN ? 'admin' : 'employee',
      password: 'test-password',
    },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  expect(cookie).toBeTruthy();
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(';', 1)[0]!;
}

describe('device-binding admin routes', () => {
  it('requires a session and does not exempt the endpoints from the onboarding gate', async () => {
    const harness = await makeHarness();
    const anonymous = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/device-bindings/pending',
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const anonymousWrite = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers: { origin: ORIGIN },
    });
    expect(anonymousWrite.statusCode).toBe(401);
    expect(anonymousWrite.headers['cache-control']).toBe('no-store');

    const cookie = await login(harness.app, UserRole.ADMIN);
    harness.setOnboardingBlocked(true);
    const gated = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/device-bindings/pending',
      headers: { cookie },
    });
    expect(gated.statusCode).toBe(403);
    expect(gated.json()).toMatchObject({ code: 'ONBOARDING_REQUIRED' });
    expect(gated.headers['cache-control']).toBe('no-store');
  });

  it('lists, approves, and revokes bindings for an Admin with safe no-store DTOs and audit context', async () => {
    const harness = await makeHarness();
    const cookie = await login(harness.app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/device-bindings/pending',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json()).toHaveLength(2);
    const expectedKeys = [
      'approvedAt',
      'createdAt',
      'deviceName',
      'employeeId',
      'id',
      'requestedAt',
      'revokedAt',
      'status',
      'updatedAt',
    ].sort();
    expect(Object.keys(listed.json()[0]).sort()).toEqual(expectedKeys);
    expect(listed.body).not.toContain(HASH_SENTINEL);
    expect(listed.body).not.toContain('deviceIdHash');
    expect(listed.body).not.toContain('sessionId');

    const approved = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.headers['cache-control']).toBe('no-store');
    expect(approved.json()).toMatchObject({ id: PENDING_BINDING_ID, status: 'APPROVED' });
    expect(approved.body).not.toContain(HASH_SENTINEL);

    const revoked = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/revoke`,
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.headers['cache-control']).toBe('no-store');
    expect(revoked.json()).toMatchObject({ id: PENDING_BINDING_ID, status: 'REVOKED' });
    expect(revoked.body).not.toContain(HASH_SENTINEL);

    const approvalEvent = harness.events.find(
      (event) => event.action === 'device_binding.approved',
    );
    const revokeEvent = harness.events.find((event) => event.action === 'device_binding.revoked');
    expect(approvalEvent).toMatchObject({
      actor: { userAccountId: ADMIN_ACCOUNT_ID, role: UserRole.ADMIN },
      clientIp: '127.0.0.1',
      entityId: PENDING_BINDING_ID,
    });
    expect(approvalEvent?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(revokeEvent?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(harness.events)).not.toContain(HASH_SENTINEL);
  });

  it('rejects non-admin sessions server-side for read and write operations', async () => {
    const harness = await makeHarness();
    const cookie = await login(harness.app, UserRole.EMPLOYEE);
    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/device-bindings/pending',
      headers: { cookie },
    });
    const write = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers: { cookie, origin: ORIGIN },
    });

    for (const response of [read, write]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(harness.repository.findById(PENDING_BINDING_ID)?.status).toBe(
      DeviceBindingStatus.PENDING,
    );
  });

  it('rejects cross-origin writes and marks the error response no-store', async () => {
    const harness = await makeHarness();
    const cookie = await login(harness.app, UserRole.ADMIN);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers: { cookie, origin: 'https://attacker.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(harness.repository.findById(PENDING_BINDING_ID)?.status).toBe(
      DeviceBindingStatus.PENDING,
    );
  });

  it('rejects malformed UUIDs and non-empty strict write bodies with no-store errors', async () => {
    const harness = await makeHarness();
    const cookie = await login(harness.app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const invalidId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/admin/device-bindings/not-a-uuid/approve',
      headers,
    });
    const invalidBody = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers,
      payload: { approvedByUserAccountId: ADMIN_ACCOUNT_ID },
    });

    for (const response of [invalidId, invalidBody]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_DEVICE_BINDING_INPUT' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(harness.repository.findById(PENDING_BINDING_ID)?.status).toBe(
      DeviceBindingStatus.PENDING,
    );
  });

  it('keeps domain errors no-store', async () => {
    const harness = await makeHarness();
    const cookie = await login(harness.app, UserRole.ADMIN);
    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/admin/device-bindings/76e6b25a-2b7a-49f8-b0d9-0ccf12671ea3/approve',
      headers: { cookie, origin: ORIGIN },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(missing.json()).toMatchObject({ code: 'DEVICE_BINDING_NOT_FOUND' });
  });

  it('applies the configured sensitive write rate limit and keeps the rejection no-store', async () => {
    const harness = await makeHarness({ sensitiveRateLimit: { max: 1, timeWindow: '1 minute' } });
    const cookie = await login(harness.app, UserRole.ADMIN);
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/device-bindings/${PENDING_BINDING_ID}/approve`,
      headers: { cookie, origin: ORIGIN },
    };
    const first = await harness.app.inject(request);
    const limited = await harness.app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
  });
});
