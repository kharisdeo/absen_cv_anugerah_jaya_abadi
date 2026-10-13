import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import {
  AttendanceValidationStatus,
  DeviceBindingStatus,
  UserRole,
} from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import {
  AttendanceVerificationService,
  type AttendanceVerificationRecord,
  type AttendanceVerificationRepository,
} from '../../src/modules/attendance/verification-workflow.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const ATTENDANCE_ID = '00000000-0000-4000-8000-000000000401';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000402';
const STORE_ID = '00000000-0000-4000-8000-000000000403';
const OUT_OF_SCOPE_ATTENDANCE_ID = '00000000-0000-4000-8000-000000000406';
const OUT_OF_SCOPE_STORE_ID = '00000000-0000-4000-8000-000000000407';
const RANDOM_ATTENDANCE_ID = '00000000-0000-4000-8000-000000000408';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000409';
const MALFORMED_ATTENDANCE_ID = 'not-a-uuid';
const PRIVATE_EMPLOYEE_NAME = 'Rahasia Karyawan Lintas Toko';
const PRIVATE_STORE_NAME = 'Toko Di Luar Scope';
const PRIVATE_SELFIE_URL = 'https://private.example/secret-photo?signature=not-for-outsiders';
const openApps: FastifyInstance[] = [];

function publicUser(role: UserRole): PublicAuthUser {
  const id =
    role === UserRole.ADMIN
      ? '00000000-0000-4000-8000-000000000404'
      : role === UserRole.SUPERVISOR
        ? SUPERVISOR_ID
        : '00000000-0000-4000-8000-000000000405';
  return {
    id,
    username: role.toLowerCase(),
    role,
    employeeId: null,
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
      employeeId: null,
      deviceBindingId: null,
      deviceBindingStatus: DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `verification-route-${role}`,
      lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
    },
  };
}

async function makeHarness() {
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `verification-route-${role}`;
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
    cookieSecret: 'attendance-verification-route-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const verificationService = {
    listQueue: vi.fn(async (actor: { role: UserRole }) => {
      if (actor.role === UserRole.EMPLOYEE) {
        throw new AppError(403, 'FORBIDDEN', 'Tidak memiliki akses.');
      }
      return { items: [], page: 1, pageSize: 25, hasNextPage: false };
    }),
    getDetail: vi.fn(async (_actor: unknown, attendanceId: string) => ({ attendanceId })),
    createSelfieReadUrl: vi.fn(async (_actor: unknown, attendanceId: string) => ({
      url: `https://private.example/${attendanceId}?signed=temporary`,
      expiresAt: '2026-10-11T00:02:00.000Z',
    })),
    decide: vi.fn(async (_actor: unknown, attendanceId: string, body: unknown) => ({
      attendanceId,
      body,
    })),
  };
  const assignmentService = {
    list: vi.fn(async () => []),
    create: vi.fn(async (actor: { role: UserRole }, input: unknown) => {
      if (actor.role !== UserRole.ADMIN) {
        throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola penugasan.');
      }
      return input;
    }),
    delete: vi.fn(async () => {}),
  };
  const app = await buildApp({
    logger: false,
    auth,
    attendanceVerifications: { service: verificationService as never },
    supervisorStoreAssignments: { service: assignmentService as never },
  });
  openApps.push(app);
  return { app, verificationService, assignmentService };
}

function makePrivatePendingRecord(
  attendanceId: string,
  storeId: string,
  storeName: string,
): AttendanceVerificationRecord {
  return {
    attendanceId,
    employee: { id: OTHER_EMPLOYEE_ID, fullName: PRIVATE_EMPLOYEE_NAME, position: 'Operator' },
    store: { id: storeId, name: storeName },
    type: 'CHECK_IN',
    workDate: '2026-10-11',
    serverTime: new Date('2026-10-11T03:00:00.000Z'),
    deviceTime: new Date('2026-10-11T02:59:00.000Z'),
    validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
    method: 'GPS',
    networkStatus: 'ONLINE',
    sourceAttemptId: '00000000-0000-4000-8000-000000000410',
    deviceName: 'Private employee phone',
    location: {
      latitude: -6.212345,
      longitude: 106.812345,
      accuracyMeters: 8,
      distanceMeters: 12,
    },
  };
}

async function makeScopedVerificationHarness() {
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `scoped-verification-route-${role}`;
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
    cookieSecret: 'attendance-scoped-verification-route-cookie-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;

  const inScope = makePrivatePendingRecord(ATTENDANCE_ID, STORE_ID, 'Toko Scope Supervisor');
  const outOfScope = makePrivatePendingRecord(
    OUT_OF_SCOPE_ATTENDANCE_ID,
    OUT_OF_SCOPE_STORE_ID,
    PRIVATE_STORE_NAME,
  );
  const records = [inScope, outOfScope];
  const repositoryCalls = {
    listPending: vi.fn(),
    findPending: vi.fn(),
    listHistory: vi.fn(),
    decide: vi.fn(),
    successfulDecisions: 0,
  };
  const canRead = (
    actor: { userAccountId: string; role: UserRole },
    row: AttendanceVerificationRecord,
  ) =>
    actor.role === UserRole.ADMIN ||
    (actor.role === UserRole.SUPERVISOR &&
      actor.userAccountId === SUPERVISOR_ID &&
      row.store?.id === STORE_ID);
  const repository: AttendanceVerificationRepository = {
    async listPending(input) {
      repositoryCalls.listPending(input);
      const items = records.filter(
        (row) =>
          canRead(input.actor, row) &&
          (input.storeId === undefined || row.store?.id === input.storeId),
      );
      return { items, hasNextPage: false };
    },
    async findPending(input) {
      repositoryCalls.findPending(input);
      const row = records.find((candidate) => candidate.attendanceId === input.attendanceId);
      return row && canRead(input.actor, row) ? row : null;
    },
    async listHistory(input) {
      repositoryCalls.listHistory(input);
      return [];
    },
    async decide(input) {
      repositoryCalls.decide(input);
      const row = records.find((candidate) => candidate.attendanceId === input.attendanceId);
      if (!row || !canRead(input.actor, row)) {
        throw new AppError(
          404,
          'ATTENDANCE_VERIFICATION_NOT_FOUND',
          'Data verifikasi absensi tidak ditemukan.',
        );
      }
      repositoryCalls.successfulDecisions += 1;
      return {
        attendanceId: row.attendanceId,
        validationStatus: input.decision,
        reviewedAt: input.reviewedAt,
        serverTime: row.serverTime,
        deviceTime: row.deviceTime,
      };
    },
  };
  const selfieReader = {
    createReviewReadUrl: vi.fn(async () => ({
      url: PRIVATE_SELFIE_URL,
      expiresAt: '2026-10-11T03:02:00.000Z',
    })),
  };
  const service = new AttendanceVerificationService(repository, selfieReader);
  const app = await buildApp({ logger: false, auth, attendanceVerifications: { service } });
  openApps.push(app);
  return { app, repositoryCalls, selfieReader };
}

function expectPrivateDenial(
  response: { statusCode: number; body: string; headers: Record<string, unknown>; json(): unknown },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ status, code });
  expect(response.body).not.toContain(PRIVATE_EMPLOYEE_NAME);
  expect(response.body).not.toContain(PRIVATE_STORE_NAME);
  expect(response.body).not.toContain(PRIVATE_SELFIE_URL);
  expect(response.body).not.toContain('106.812345');
  expect(response.body).not.toContain('Private employee phone');
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

describe('attendance verification routes', () => {
  it('registers the queue and rejects Employee while allowing Admin and Supervisor', async () => {
    const { app, verificationService } = await makeHarness();
    const adminCookie = await login(app, UserRole.ADMIN);
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const employeeCookie = await login(app, UserRole.EMPLOYEE);

    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/verifications',
      headers: { cookie: adminCookie },
    });
    const supervisor = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/verifications',
      headers: { cookie: supervisorCookie },
    });
    const employee = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/verifications',
      headers: { cookie: employeeCookie },
    });

    expect(admin.statusCode).toBe(200);
    expect(supervisor.statusCode).toBe(200);
    expect(employee.statusCode).toBe(403);
    expect(admin.headers['cache-control']).toBe('no-store');
    expect(verificationService.listQueue).toHaveBeenCalledTimes(3);
  });

  it('uses the scoped verification selfie route and never caches signed URLs', async () => {
    const { app, verificationService } = await makeHarness();
    const cookie = await login(app, UserRole.SUPERVISOR);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/verifications/${ATTENDANCE_ID}/selfie-url`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ url: expect.stringContaining(ATTENDANCE_ID) });
    expect(verificationService.createSelfieReadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.SUPERVISOR, userAccountId: SUPERVISOR_ID }),
      ATTENDANCE_ID,
    );
  });

  it('requires Origin on decisions and routes valid decisions to the service', async () => {
    const { app, verificationService } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const url = `/api/v1/attendance/verifications/${ATTENDANCE_ID}/decision`;
    const csrf = await app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { decision: 'APPROVED' },
    });
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, cookie },
      payload: { decision: 'REJECTED', reason: 'Bukti tidak cocok' },
    });

    expect(csrf.statusCode).toBe(403);
    expect(csrf.headers['cache-control']).toBe('no-store');
    expect(response.statusCode).toBe(200);
    expect(verificationService.decide).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.ADMIN }),
      ATTENDANCE_ID,
      { decision: 'REJECTED', reason: 'Bukti tidak cocok' },
      expect.any(String),
    );
  });

  it('keeps Supervisor list filters inside the authenticated store scope', async () => {
    const { app, repositoryCalls } = await makeScopedVerificationHarness();
    const cookie = await login(app, UserRole.SUPERVISOR);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/verifications?storeId=${OUT_OF_SCOPE_STORE_ID}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ items: [], page: 1, pageSize: 25, hasNextPage: false });
    expect(repositoryCalls.listPending).toHaveBeenCalledWith({
      actor: { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR },
      storeId: OUT_OF_SCOPE_STORE_ID,
      skip: 0,
      take: 26,
    });
    expect(response.body).not.toContain(PRIVATE_EMPLOYEE_NAME);
    expect(response.body).not.toContain(PRIVATE_STORE_NAME);
    expect(response.body).not.toContain('106.812345');
  });

  it('rejects SQL syntax in a UUID query filter before calling the verification service', async () => {
    const { app, verificationService } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/verifications?storeId=%27%20OR%20%271%27%3D%271--',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_VERIFICATION_INPUT' });
    expect(verificationService.listQueue).not.toHaveBeenCalled();
  });

  it('returns indistinguishable scoped 404s for another-store and random IDs without releasing evidence', async () => {
    const { app, repositoryCalls, selfieReader } = await makeScopedVerificationHarness();
    const cookie = await login(app, UserRole.SUPERVISOR);
    const deniedResponses = [];

    for (const attendanceId of [OUT_OF_SCOPE_ATTENDANCE_ID, RANDOM_ATTENDANCE_ID]) {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/verifications/${attendanceId}`,
        headers: { cookie },
      });
      const selfie = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/verifications/${attendanceId}/selfie-url`,
        headers: { cookie },
      });
      const decision = await app.inject({
        method: 'POST',
        url: `/api/v1/attendance/verifications/${attendanceId}/decision`,
        headers: { origin: ORIGIN, cookie },
        payload: { decision: 'APPROVED' },
      });
      deniedResponses.push(detail, selfie, decision);
      for (const response of [detail, selfie, decision]) {
        expectPrivateDenial(response, 404, 'ATTENDANCE_VERIFICATION_NOT_FOUND');
      }
    }

    const malformed = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/verifications/${MALFORMED_ATTENDANCE_ID}`,
      headers: { cookie },
    });
    expectPrivateDenial(malformed, 400, 'INVALID_VERIFICATION_INPUT');
    expect(deniedResponses.map((response) => response.json())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 404, code: 'ATTENDANCE_VERIFICATION_NOT_FOUND' }),
      ]),
    );
    expect(repositoryCalls.findPending).toHaveBeenCalledTimes(4);
    expect(repositoryCalls.listHistory).not.toHaveBeenCalled();
    expect(repositoryCalls.successfulDecisions).toBe(0);
    expect(selfieReader.createReviewReadUrl).not.toHaveBeenCalled();
  });

  it('denies Employee verification detail, selfie and decision before any evidence read', async () => {
    const { app, repositoryCalls, selfieReader } = await makeScopedVerificationHarness();
    const cookie = await login(app, UserRole.EMPLOYEE);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/verifications/${ATTENDANCE_ID}`,
      headers: { cookie },
    });
    const selfie = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/verifications/${ATTENDANCE_ID}/selfie-url`,
      headers: { cookie },
    });
    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/verifications/${ATTENDANCE_ID}/decision`,
      headers: { origin: ORIGIN, cookie },
      payload: { decision: 'APPROVED' },
    });

    for (const response of [detail, selfie, decision]) {
      expectPrivateDenial(response, 403, 'FORBIDDEN');
    }
    expect(repositoryCalls.findPending).not.toHaveBeenCalled();
    expect(repositoryCalls.listHistory).not.toHaveBeenCalled();
    expect(repositoryCalls.decide).not.toHaveBeenCalled();
    expect(selfieReader.createReviewReadUrl).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied store scope on verification decisions before repository access', async () => {
    const { app, repositoryCalls } = await makeScopedVerificationHarness();
    const cookie = await login(app, UserRole.SUPERVISOR);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/verifications/${ATTENDANCE_ID}/decision`,
      headers: { origin: ORIGIN, cookie },
      payload: { decision: 'APPROVED', storeId: OUT_OF_SCOPE_STORE_ID },
    });

    expectPrivateDenial(response, 400, 'INVALID_VERIFICATION_INPUT');
    expect(repositoryCalls.findPending).not.toHaveBeenCalled();
    expect(repositoryCalls.decide).not.toHaveBeenCalled();
  });
});

describe('Admin supervisor-store assignment routes', () => {
  it('allows only Admin to create trusted store assignments', async () => {
    const { app, assignmentService } = await makeHarness();
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const adminCookie = await login(app, UserRole.ADMIN);
    const url = '/api/v1/admin/supervisor-store-assignments';
    const payload = { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID };

    const denied = await app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, cookie: supervisorCookie },
      payload,
    });
    const created = await app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, cookie: adminCookie },
      payload,
    });

    expect(denied.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(assignmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.ADMIN }),
      payload,
      expect.any(String),
    );
  });
});
