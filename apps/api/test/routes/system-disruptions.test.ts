import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  SystemDisruptionService,
  type SystemDisruptionRecord,
  type SystemDisruptionRepository,
} from '../../src/modules/system-disruption/index.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const STORE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_STORE_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-11T03:00:00.000Z');
const openApps: FastifyInstance[] = [];

function accountId(role: UserRole): string {
  return role === UserRole.ADMIN ? ADMIN_ID : '00000000-0000-4000-8000-000000000077';
}

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: accountId(role),
    username: role.toLowerCase(),
    role,
    employeeId: role === UserRole.EMPLOYEE ? '00000000-0000-4000-8000-000000000078' : null,
    deviceBindingStatus: role === UserRole.ADMIN ? null : DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
  };
}

function makeSession(role: UserRole): AuthenticatedSession {
  const user = publicUser(role);
  return {
    user,
    principal: {
      userAccountId: user.id,
      role,
      username: user.username,
      employeeId: user.employeeId,
      deviceBindingId: role === UserRole.ADMIN ? null : '00000000-0000-4000-8000-000000000079',
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `system-disruption-test-${role}`,
      lastSeenAt: NOW,
    },
  };
}

class FakeRepository implements SystemDisruptionRepository {
  readonly rows: SystemDisruptionRecord[] = [];

  async create(input: Parameters<SystemDisruptionRepository['create']>[0]) {
    const row: SystemDisruptionRecord = {
      ...input,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(row);
    return row;
  }

  async list(input: Parameters<SystemDisruptionRepository['list']>[0]) {
    const rows = this.rows
      .filter((row) => input.storeId === undefined || row.storeId === input.storeId)
      .sort((left, right) => right.startsAt.getTime() - left.startsAt.getTime());
    const items = rows.slice(input.skip, input.skip + input.take);
    return { items, hasNextPage: items.length === input.take };
  }
}

async function harness() {
  const repository = new FakeRepository();
  const events: RecordAuditEventInput[] = [];
  const service = new SystemDisruptionService(repository, {
    async record(event) {
      events.push(event);
      return {} as never;
    },
  });
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `system-disruption-token-${role}`;
      sessions.set(token, makeSession(role));
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
    cookieSecret: 'system-disruption-route-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({ logger: false, auth, systemDisruptions: { service } });
  openApps.push(app);
  return { app, repository, events };
}

async function login(app: FastifyInstance, role: UserRole): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { identifier: role, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookie) throw new Error('System disruption test login did not set a cookie.');
  return cookie.split(';', 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('system disruption routes', () => {
  it('requires authentication and Admin role for list and create', async () => {
    const { app, events } = await harness();
    const anonymousRead = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-disruptions',
    });
    const anonymousWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { origin: ORIGIN },
      payload: {
        startsAt: '2026-10-11T09:00:00+07:00',
        endsAt: '2026-10-11T10:00:00+07:00',
        reason: 'Gangguan',
      },
    });
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const supervisorRead = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie: supervisorCookie },
    });
    const employeeWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie: employeeCookie, origin: ORIGIN },
      payload: {
        startsAt: '2026-10-11T09:00:00+07:00',
        endsAt: '2026-10-11T10:00:00+07:00',
        reason: 'Gangguan',
      },
    });

    expect(anonymousRead.statusCode).toBe(401);
    expect(anonymousWrite.statusCode).toBe(401);
    expect(supervisorRead.statusCode).toBe(403);
    expect(employeeWrite.statusCode).toBe(403);
    for (const response of [anonymousRead, anonymousWrite, supervisorRead, employeeWrite]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(events).toEqual([]);
  });

  it('requires same-origin for writes and rejects invalid strict payloads before service effects', async () => {
    const { app, repository, events } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie },
      payload: {
        startsAt: '2026-10-11T09:00:00Z',
        endsAt: '2026-10-11T10:00:00Z',
        reason: 'Gangguan',
      },
    });
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie, origin: 'https://attacker.example' },
      payload: {
        startsAt: '2026-10-11T09:00:00Z',
        endsAt: '2026-10-11T10:00:00Z',
        reason: 'Gangguan',
      },
    });
    const invalids = await Promise.all(
      [
        {},
        { startsAt: '2026-10-11T09:00:00Z', endsAt: '2026-10-11T09:00:00Z', reason: 'Gangguan' },
        { startsAt: '2026-02-30T09:00:00Z', endsAt: '2026-10-11T10:00:00Z', reason: 'Gangguan' },
        { startsAt: '2026-10-11T09:00:00', endsAt: '2026-10-11T10:00:00Z', reason: 'Gangguan' },
        { startsAt: '2026-10-11T09:00:00Z', endsAt: '2026-10-11T10:00:00Z', reason: '   ' },
        {
          startsAt: '2026-10-11T09:00:00Z',
          endsAt: '2026-10-11T10:00:00Z',
          reason: 'Gangguan',
          isActive: false,
        },
      ].map((payload) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/system-disruptions',
          headers: { cookie, origin: ORIGIN },
          payload,
        }),
      ),
    );

    expect(missingOrigin.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(invalids.every((response) => response.statusCode === 400)).toBe(true);
    expect(invalids.every((response) => response.json().code === 'INVALID_SYSTEM_DISRUPTION')).toBe(
      true,
    );
    expect(repository.rows).toEqual([]);
    expect(events).toEqual([]);
  });

  it('creates global and store records, audits each create, filters reads by store and paginates', async () => {
    const { app, repository, events } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const createGlobal = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers,
      payload: {
        startsAt: '2026-10-11T09:00:00+07:00',
        endsAt: '2026-10-11T11:00:00+07:00',
        reason: ' Gangguan koneksi global ',
      },
    });
    const createStore = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers,
      payload: {
        storeId: STORE_ID,
        startsAt: '2026-10-11T10:00:00+07:00',
        endsAt: '2026-10-11T12:00:00+07:00',
        reason: 'Gangguan yang overlap untuk toko',
      },
    });
    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-disruptions?page=1&pageSize=1',
      headers,
    });
    const scoped = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/system-disruptions?storeId=${STORE_ID}`,
      headers,
    });
    const otherStore = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/system-disruptions?storeId=${OTHER_STORE_ID}`,
      headers,
    });

    expect(createGlobal.statusCode).toBe(201);
    expect(createGlobal.json()).toMatchObject({
      storeId: null,
      reason: 'Gangguan koneksi global',
      isActive: true,
    });
    expect(createStore.statusCode).toBe(201);
    expect(createStore.json().storeId).toBe(STORE_ID);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ page: 1, pageSize: 1, hasNextPage: true });
    expect(scoped.json().items).toHaveLength(1);
    expect(scoped.json().items[0].storeId).toBe(STORE_ID);
    expect(otherStore.json().items).toEqual([]);
    expect(
      [createGlobal, createStore, all, scoped, otherStore].every(
        (response) => response.headers['cache-control'] === 'no-store',
      ),
    ).toBe(true);
    expect(repository.rows).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.map(({ action }) => action)).toEqual([
      'system_disruption.create',
      'system_disruption.create',
    ]);
    expect(events[1]).toMatchObject({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      entityType: 'system_disruption',
      entityId: createStore.json().id,
      reason: 'Gangguan yang overlap untuk toko',
    });
  });

  it('rejects invalid list filters and unknown query keys', async () => {
    const { app } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    for (const query of ['?page=0', '?pageSize=51', '?storeId=not-a-uuid', '?unexpected=true']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/system-disruptions${query}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_SYSTEM_DISRUPTION');
    }
  });
});
