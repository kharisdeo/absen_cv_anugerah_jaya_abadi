import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog } from '../../src/generated/prisma/client.js';
import {
  AuditService,
  type AuditLogFindManyQuery,
  type AuditLogRepository,
} from '../../src/modules/audit/index.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ORIGIN = 'http://localhost:5173';
const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000077';
const EMPLOYEE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000078';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000079';
const STORE_ID = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '00000000-0000-4000-8000-000000000010';
const AUDIT_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];
const NOW = new Date('2026-10-11T03:00:00.000Z');
const openApps: FastifyInstance[] = [];

function accountId(role: UserRole): string {
  if (role === UserRole.ADMIN) return ADMIN_ID;
  if (role === UserRole.SUPERVISOR) return SUPERVISOR_ID;
  return EMPLOYEE_ACCOUNT_ID;
}

function publicUser(role: UserRole): PublicAuthUser {
  return {
    id: accountId(role),
    username: role.toLowerCase(),
    role,
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
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
      deviceBindingId: role === UserRole.ADMIN ? null : '00000000-0000-4000-8000-000000000080',
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `audit-log-test-${role}`,
      lastSeenAt: NOW,
    },
  };
}

function makeRow(index: number, occurredAt: Date): AuditLog {
  return Object.assign(
    {
      id: AUDIT_IDS[index - 1]!,
      actorUserAccountId: ADMIN_ID,
      occurredAt,
      clientIp: '192.0.2.10',
      deviceIdHash: 'device-hash',
      action: 'store.update',
      entityType: 'store',
      entityId: STORE_ID,
      beforeData: { name: `Nama ${index} sebelumnya` },
      afterData: { name: `Nama ${index} baru` },
      reason: 'Perubahan data toko',
      requestId: REQUEST_ID,
    },
    { internalOnlyMarker: 'DO_NOT_RETURN' },
  ) as AuditLog;
}

class MemoryAuditLogRepository implements AuditLogRepository {
  readonly rows: readonly AuditLog[] = [
    makeRow(1, new Date('2026-10-11T03:02:00.000Z')),
    makeRow(2, new Date('2026-10-11T03:01:00.000Z')),
    makeRow(3, new Date('2026-10-11T03:00:00.000Z')),
  ];
  readonly queries: AuditLogFindManyQuery[] = [];
  createCalls = 0;

  async create(): Promise<AuditLog> {
    this.createCalls += 1;
    throw new Error('Audit listing must not create audit rows.');
  }

  async findMany(query: AuditLogFindManyQuery): Promise<readonly AuditLog[]> {
    this.queries.push(query);
    const filtered = this.rows
      .filter((row) => {
        const { where } = query;
        if (where.actorUserAccountId && row.actorUserAccountId !== where.actorUserAccountId)
          return false;
        if (where.action && row.action !== where.action) return false;
        if (where.entityType && row.entityType !== where.entityType) return false;
        if (where.entityId && row.entityId !== where.entityId) return false;
        if (where.occurredAt?.gte && row.occurredAt < where.occurredAt.gte) return false;
        if (where.occurredAt?.lte && row.occurredAt > where.occurredAt.lte) return false;
        return true;
      })
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id),
      );
    return filtered.slice(query.skip, query.skip + query.take);
  }
}

async function harness(options: { rateLimit?: { max: number; timeWindow: string } } = {}) {
  const repository = new MemoryAuditLogRepository();
  const audit = new AuditService(repository);
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role = Object.values(UserRole).find((value) => value === input.identifier);
      if (!role) throw new AppError(401, 'INVALID_CREDENTIALS', 'Kredensial tidak valid.');
      const token = `audit-log-token-${role}`;
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
    cookieSecret: 'audit-log-route-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    ...(options.rateLimit ? { sensitiveRateLimit: options.rateLimit } : {}),
  } satisfies AuthRoutesOptions;
  const app = await buildApp({ logger: false, auth, auditLogs: { service: audit } });
  openApps.push(app);
  return { app, repository };
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
  if (!cookie) throw new Error('Audit log test login did not set a cookie.');
  return cookie.split(';', 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('Admin audit-log routes', () => {
  it('maps Admin filters and bounded pagination to a safe no-store DTO', async () => {
    const { app, repository } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/v1/admin/audit-logs?actorUserAccountId=${ADMIN_ID.toUpperCase()}` +
        '&action=store.update&entityType=store' +
        `&entityId=${STORE_ID}&from=2026-10-11T03:00:00.000Z` +
        '&to=2026-10-11T03:03:00.000Z&page=2&pageSize=1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      items: [
        {
          id: AUDIT_IDS[1],
          actorUserAccountId: ADMIN_ID,
          occurredAt: '2026-10-11T03:01:00.000Z',
          clientIp: '192.0.2.10',
          deviceIdHash: 'device-hash',
          action: 'store.update',
          entityType: 'store',
          entityId: STORE_ID,
          beforeData: { name: 'Nama 2 sebelumnya' },
          afterData: { name: 'Nama 2 baru' },
          reason: 'Perubahan data toko',
          requestId: REQUEST_ID,
        },
      ],
      page: 2,
      pageSize: 1,
      hasNextPage: true,
    });
    expect(response.json().items[0]).not.toHaveProperty('internalOnlyMarker');
    expect(repository.queries).toHaveLength(1);
    expect(repository.queries[0]).toEqual({
      where: {
        actorUserAccountId: ADMIN_ID,
        action: 'store.update',
        entityType: 'store',
        entityId: STORE_ID,
        occurredAt: {
          gte: new Date('2026-10-11T03:00:00.000Z'),
          lte: new Date('2026-10-11T03:03:00.000Z'),
        },
      },
      skip: 1,
      take: 2,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('denies anonymous users and non-Admin roles before querying the repository', async () => {
    const { app, repository } = await harness();
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs' });
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const supervisor = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie: supervisorCookie },
    });
    const employee = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie: employeeCookie },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(supervisor.statusCode).toBe(403);
    expect(employee.statusCode).toBe(403);
    for (const response of [anonymous, supervisor, employee]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
    expect(repository.queries).toEqual([]);
  });

  it('rejects invalid, out-of-range, and unknown query parameters before repository access', async () => {
    const { app, repository } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const invalidQueries = [
      '?unexpected=true',
      '?page=0',
      '?page=10001',
      '?pageSize=101',
      '?from=2026-02-30T03:00:00.000Z',
      '?from=2026-10-11T04:00:00.000Z&to=2026-10-11T03:00:00.000Z',
    ];
    const responses = await Promise.all(
      invalidQueries.map((query) =>
        app.inject({ method: 'GET', url: `/api/v1/admin/audit-logs${query}`, headers: { cookie } }),
      ),
    );

    const responseTable = responses.map((response, index) => ({
      query: invalidQueries[index],
      status: response.statusCode,
      code: response.json().code,
    }));
    expect(responseTable).toEqual(
      invalidQueries.map((query) => ({ query, status: 400, code: 'INVALID_AUDIT_INPUT' })),
    );
    for (const response of responses) {
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(repository.queries).toEqual([]);
  });

  it('does not register any audit-log mutation route', async () => {
    const { app, repository } = await harness();
    const cookie = await login(app, UserRole.ADMIN);
    const responses = await Promise.all(
      (['POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) =>
        app.inject({
          method,
          url: '/api/v1/admin/audit-logs',
          headers: { cookie, origin: ORIGIN },
          payload: {},
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404]);
    for (const response of responses) {
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
    expect(repository.queries).toEqual([]);
    expect(repository.createCalls).toBe(0);
  });

  it('rate-limits audit list requests and keeps the rejection no-store', async () => {
    const { app, repository } = await harness({ rateLimit: { max: 1, timeWindow: '1 minute' } });
    const cookie = await login(app, UserRole.ADMIN);
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie },
    });
    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie },
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(repository.queries).toHaveLength(1);
  });
});
