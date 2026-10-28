import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
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
const SECOND_ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2c';
const STORE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_STORE_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-11T03:00:00.000Z');
const IDEMPOTENCY_KEY = '10000000-0000-4000-8000-000000000001';
const SECOND_IDEMPOTENCY_KEY = '10000000-0000-4000-8000-000000000002';
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
  private readonly idempotency = new Map<
    string,
    Readonly<{ fingerprint: string; record: SystemDisruptionRecord }>
  >();
  private lock: Promise<void> = Promise.resolve();

  async createIdempotently(
    input: Parameters<SystemDisruptionRepository['createIdempotently']>[0],
    writeAudit: Parameters<SystemDisruptionRepository['createIdempotently']>[1],
  ) {
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const key = `${input.createdByUserAccountId}:${input.idempotencyKeyHash}`;
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== input.requestFingerprint) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Key dipakai payload lain.');
        }
        return { record: existing.record, replayed: true };
      }

      const row: SystemDisruptionRecord = {
        id: input.id,
        storeId: input.storeId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
        createdByUserAccountId: input.createdByUserAccountId,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await writeAudit({} as Prisma.TransactionClient);
      this.rows.push(row);
      this.idempotency.set(key, { fingerprint: input.requestFingerprint, record: row });
      return { record: row, replayed: false };
    } finally {
      release();
    }
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
    async recordInTransaction(_transaction, event) {
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
  return { app, repository, events, service };
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
      headers: { cookie: employeeCookie, origin: ORIGIN, 'idempotency-key': IDEMPOTENCY_KEY },
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
    const missingIdempotencyKey = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie, origin: ORIGIN },
      payload: {
        startsAt: '2026-10-11T09:00:00Z',
        endsAt: '2026-10-11T10:00:00Z',
        reason: 'Gangguan',
      },
    });
    const invalidIdempotencyKey = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: { cookie, origin: ORIGIN, 'idempotency-key': 'not-random-or-valid' },
      payload: {
        startsAt: '2026-10-11T09:00:00Z',
        endsAt: '2026-10-11T10:00:00Z',
        reason: 'Gangguan',
      },
    });
    const invalids: Awaited<ReturnType<typeof app.inject>>[] = await Promise.all(
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
          headers: { cookie, origin: ORIGIN, 'idempotency-key': IDEMPOTENCY_KEY },
          payload,
        }),
      ),
    );

    expect(missingOrigin.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingIdempotencyKey.statusCode).toBe(400);
    expect(missingIdempotencyKey.json().code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(invalidIdempotencyKey.statusCode).toBe(400);
    expect(invalidIdempotencyKey.json().code).toBe('INVALID_IDEMPOTENCY_KEY');
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
    let keyIndex = 1;
    const readHeaders = { cookie, origin: ORIGIN };
    const createHeaders = () => ({
      ...readHeaders,
      'idempotency-key': `10000000-0000-4000-8000-${String(keyIndex++).padStart(12, '0')}`,
    });
    const createGlobal = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: createHeaders(),
      payload: {
        startsAt: '2026-10-11T09:00:00+07:00',
        endsAt: '2026-10-11T11:00:00+07:00',
        reason: ' Gangguan koneksi global ',
      },
    });
    const createStore = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers: createHeaders(),
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
      headers: readHeaders,
    });
    const scoped = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/system-disruptions?storeId=${STORE_ID}`,
      headers: readHeaders,
    });
    const otherStore = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/system-disruptions?storeId=${OTHER_STORE_ID}`,
      headers: readHeaders,
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

  it('replays an identical normalized payload without a second record or audit and conflicts on a changed payload', async () => {
    const { app, repository, events } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN, 'idempotency-key': IDEMPOTENCY_KEY };
    const firstPayload = {
      startsAt: '2026-10-11T09:00:00+07:00',
      endsAt: '2026-10-11T10:00:00+07:00',
      reason: ' Gangguan koneksi ',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers,
      payload: firstPayload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers,
      payload: {
        startsAt: '2026-10-11T02:00:00Z',
        endsAt: '2026-10-11T03:00:00Z',
        reason: 'Gangguan koneksi',
      },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/system-disruptions',
      headers,
      payload: { ...firstPayload, reason: 'Gangguan koneksi lain' },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(repository.rows).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('serializes concurrent duplicate creates and scopes the same key to the server-authenticated actor', async () => {
    const { app, repository, events, service } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/system-disruptions',
        headers: { cookie, origin: ORIGIN, 'idempotency-key': IDEMPOTENCY_KEY },
        payload: {
          startsAt: '2026-10-11T09:00:00+07:00',
          endsAt: '2026-10-11T10:00:00+07:00',
          reason: 'Gangguan simultan',
        },
      });
    const [first, second] = await Promise.all([request(), request()]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toEqual(second.json());
    expect(repository.rows).toHaveLength(1);
    expect(events).toHaveLength(1);

    const input = {
      startsAt: '2026-10-11T09:00:00+07:00',
      endsAt: '2026-10-11T10:00:00+07:00',
      reason: 'Gangguan simultan',
    };
    const firstActor = makeSession(UserRole.ADMIN).principal;
    const secondActor = { ...firstActor, userAccountId: SECOND_ADMIN_ID };
    await service.create(firstActor, input, SECOND_IDEMPOTENCY_KEY);
    await service.create(secondActor, input, SECOND_IDEMPOTENCY_KEY);
    expect(repository.rows).toHaveLength(3);
    expect(events).toHaveLength(3);
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
