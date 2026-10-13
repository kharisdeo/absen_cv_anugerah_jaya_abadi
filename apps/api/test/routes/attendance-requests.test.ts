import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import {
  DeviceBindingStatus,
  RequestStatus,
  RequestType,
  UserRole,
} from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AttendanceRequestService } from '../../src/modules/attendance-requests/index.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const REQUEST_ID = '00000000-0000-4000-8000-000000000301';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000302';
const openApps: FastifyInstance[] = [];

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : '00000000-0000-4000-8000-000000000303',
    username: role.toLowerCase(),
    role,
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
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
      employeeId: user.employeeId,
      deviceBindingId: null,
      deviceBindingStatus: DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `request-route-${role}`,
      lastSeenAt: new Date('2026-10-11T03:00:00.000Z'),
    },
  };
}

async function harness() {
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `request-route-token-${role}`;
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
    cookieSecret: 'attendance-request-route-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const service = {
    create: vi.fn(async (_principal: unknown, input: unknown) => ({ input })),
    list: vi.fn(async () => ({ items: [], page: 1, pageSize: 25, hasNextPage: false })),
    detail: vi.fn(async () => ({ id: REQUEST_ID })),
    decide: vi.fn(async () => ({ status: RequestStatus.APPROVED })),
    createAttachmentReadUrl: vi.fn(async () => ({
      url: 'https://private.example/signed-doctor-note',
      expiresAt: '2026-10-11T03:02:00.000Z',
    })),
  };
  const app = await buildApp({
    logger: false,
    auth,
    attendanceRequests: { service: service as unknown as AttendanceRequestService },
  });
  openApps.push(app);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { identifier: UserRole.EMPLOYEE, password: 'test-password' },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookie) throw new Error('Auth test did not set a cookie.');
  return { app, service, cookie: cookie.split(';')[0]! };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('attendance request routes', () => {
  it('rejects CORRECTION and client-supplied status/approver fields before service access', async () => {
    const { app, service, cookie } = await harness();
    const common = {
      startDate: '2026-10-12',
      endDate: '2026-10-12',
      reason: 'Keterangan',
    };
    for (const body of [
      { ...common, requestType: RequestType.CORRECTION },
      { ...common, requestType: RequestType.LEAVE, status: RequestStatus.APPROVED },
      { ...common, requestType: RequestType.LEAVE, approverUserAccountId: EMPLOYEE_ID },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/requests',
        headers: { cookie, origin: ORIGIN },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('uses the registered request collection and decision/detail routes', async () => {
    const { app, service, cookie } = await harness();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/requests',
      headers: { cookie, origin: ORIGIN },
      payload: {
        requestType: RequestType.LEAVE,
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Keperluan keluarga',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(service.create).toHaveBeenCalledTimes(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/requests/${REQUEST_ID}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(service.detail).toHaveBeenCalledWith(expect.any(Object), REQUEST_ID);

    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/requests/${REQUEST_ID}/decision`,
      headers: { cookie, origin: ORIGIN },
      payload: { decision: RequestStatus.APPROVED, decisionNote: 'Diterima.' },
    });
    expect(decision.statusCode).toBe(200);
    expect(service.decide).toHaveBeenCalledWith(
      expect.any(Object),
      REQUEST_ID,
      { decision: RequestStatus.APPROVED, decisionNote: 'Diterima.' },
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it('does not mint an attachment URL when the owner/scope lookup fails', async () => {
    const { app, service, cookie } = await harness();
    vi.mocked(service.createAttachmentReadUrl).mockRejectedValueOnce(
      new AppError(404, 'ATTENDANCE_REQUEST_NOT_FOUND', 'Pengajuan tidak ditemukan.'),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/requests/${REQUEST_ID}/attachment-url`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.createAttachmentReadUrl).toHaveBeenCalledWith(expect.any(Object), REQUEST_ID);
  });

  it('returns an authorized doctor-note URL with no-store caching', async () => {
    const { app, service, cookie } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/requests/${REQUEST_ID}/attachment-url`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      url: 'https://private.example/signed-doctor-note',
      expiresAt: '2026-10-11T03:02:00.000Z',
    });
    expect(service.createAttachmentReadUrl).toHaveBeenCalledWith(expect.any(Object), REQUEST_ID);
  });
});
