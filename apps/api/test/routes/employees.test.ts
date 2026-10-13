import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, EmployeeStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import { registerErrorHandlers } from '../../src/errors/register-error-handlers.js';
import type { AuditService, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import type { AuthenticatedSession } from '../../src/modules/auth/contracts.js';
import {
  EmployeeService,
  type CreateEmployeeInput,
  type EmployeeRecord,
  type EmployeeRepository,
  type EmployeeRequestContext,
  type UpdateEmployeeInput,
} from '../../src/modules/employee/index.js';
import { registerAuthPlugins, type AuthRoutesOptions } from '../../src/routes/auth.js';
import { registerEmployeeRoutes } from '../../src/routes/employees.js';

const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const SUPERVISOR_ACCOUNT_ID = '67cf4698-61cc-455e-9853-fb14acfc0123';
const EMPLOYEE_ID = 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9';
const OTHER_EMPLOYEE_ID = '8c33be2a-d48d-44db-9bc2-e111a12d19c2';
const EMPLOYEE_ACCOUNT_ID = '8f9a9fcb-5463-48dc-bc97-2cd2c6f61a2d';
const ORIGIN = 'http://localhost:5173';
const now = new Date('2026-10-11T03:15:00.000Z');

const openApps = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...openApps].map((app) => app.close()));
  openApps.clear();
});

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: EMPLOYEE_ID,
    nik: 'NIK-001',
    fullName: 'Karyawan Satu',
    position: 'Staff',
    status: EmployeeStatus.ACTIVE,
    employmentDate: new Date('2024-01-02T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(role: UserRole): AuthenticatedSession {
  const userAccountId =
    role === UserRole.ADMIN
      ? ADMIN_ID
      : role === UserRole.SUPERVISOR
        ? SUPERVISOR_ACCOUNT_ID
        : EMPLOYEE_ACCOUNT_ID;
  const employeeId = role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null;
  const principal = {
    userAccountId,
    role,
    username:
      role === UserRole.ADMIN ? 'admin' : role === UserRole.SUPERVISOR ? 'supervisor' : 'employee',
    employeeId,
    deviceBindingId: null,
    deviceBindingStatus: role === UserRole.ADMIN ? null : DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: 'session-test',
    lastSeenAt: now,
  };
  return {
    principal,
    user: {
      id: userAccountId,
      username: principal.username,
      role,
      employeeId,
      deviceBindingStatus: role === UserRole.ADMIN ? null : DeviceBindingStatus.APPROVED,
      mustChangePassword: false,
      consentRequired: false,
    },
  };
}

function makeHarness(initial: readonly EmployeeRecord[] = []) {
  const rows = [...initial];
  const repository: EmployeeRepository = {
    async list() {
      return rows;
    },
    async findById(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async findByNik(nik) {
      return rows.find((row) => row.nik === nik) ?? null;
    },
    async findAccountByUsername() {
      return null;
    },
    async create(data) {
      const employee = makeEmployee({
        ...data,
        id: '8f9a9fcb-5463-48dc-bc97-2cd2c6f61a2d',
        createdAt: now,
        updatedAt: now,
      });
      rows.push(employee);
      return employee;
    },
    async update(id, data) {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];
      if (!current) return null;
      const updated = { ...current, ...data, updatedAt: new Date(now.getTime() + 1) };
      rows[index] = updated;
      return updated;
    },
  };
  const events: RecordAuditEventInput[] = [];
  const audit = {
    async record(event: RecordAuditEventInput) {
      events.push(event);
      return {} as Awaited<ReturnType<AuditService['record']>>;
    },
  };
  const domainService = new EmployeeService(repository, audit);
  const serviceCalls = { list: 0, get: 0, create: 0, update: 0, deactivate: 0 };
  const service = {
    list: (...args: Parameters<EmployeeService['list']>) => {
      serviceCalls.list += 1;
      return domainService.list(...args);
    },
    get: (...args: Parameters<EmployeeService['get']>) => {
      serviceCalls.get += 1;
      return domainService.get(...args);
    },
    create: (
      actor: Parameters<EmployeeService['create']>[0],
      input: CreateEmployeeInput,
      context?: EmployeeRequestContext,
    ) => {
      serviceCalls.create += 1;
      return domainService.create(actor, input, context);
    },
    update: (
      actor: Parameters<EmployeeService['update']>[0],
      employeeId: string,
      input: UpdateEmployeeInput,
      context?: EmployeeRequestContext,
    ) => {
      serviceCalls.update += 1;
      return domainService.update(actor, employeeId, input, context);
    },
    deactivate: (
      actor: Parameters<EmployeeService['deactivate']>[0],
      employeeId: string,
      context?: EmployeeRequestContext,
    ) => {
      serviceCalls.deactivate += 1;
      return domainService.deactivate(actor, employeeId, context);
    },
  } as unknown as EmployeeService;
  const auth = {
    service: {
      async authenticate() {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      },
    } as unknown as AuthRoutesOptions['service'],
    cookieSecret: 'employee-route-test-cookie-secret-32-bytes',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '15 minutes' },
  } satisfies AuthRoutesOptions;

  return { rows, events, serviceCalls, service, auth };
}

async function makeRouteApp(initial: readonly EmployeeRecord[] = []) {
  const harness = makeHarness(initial);
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  openApps.add(app);
  registerErrorHandlers(app);
  app.decorateRequest('authSession', null);
  await registerAuthPlugins(app, harness.auth);
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR || role === UserRole.EMPLOYEE) {
      request.authSession = makeSession(role);
    }
  });
  await registerEmployeeRoutes(app, { service: harness.service, auth: harness.auth });
  return { app, ...harness };
}

function adminHeaders(): Record<string, string> {
  return { origin: ORIGIN, 'x-test-role': UserRole.ADMIN };
}

describe('employee routes', () => {
  it('registers no management routes when auth is absent', async () => {
    const app = await buildApp({ logger: false });
    openApps.add(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/employees' });
    expect(response.statusCode).toBe(404);
  });

  it('requires a session and returns only safe employee fields with no-store', async () => {
    const secretRecord = {
      ...makeEmployee(),
      passwordHash: 'must-not-leak',
      account: { id: EMPLOYEE_ACCOUNT_ID, username: 'hidden', passwordHash: 'also-hidden' },
    } as EmployeeRecord;
    const { app } = await makeRouteApp([secretRecord]);

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/admin/employees' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['cache-control']).toBe('no-store');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/employees',
      headers: adminHeaders(),
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/employees/${EMPLOYEE_ID}`,
      headers: adminHeaders(),
    });
    const expectedKeys = [
      'createdAt',
      'employmentDate',
      'fullName',
      'id',
      'nik',
      'position',
      'status',
      'updatedAt',
    ].sort();

    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(Object.keys(listed.json()[0]).sort()).toEqual(expectedKeys);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(Object.keys(detail.json()).sort()).toEqual(expectedKeys);
    expect(listed.body).not.toContain('passwordHash');
    expect(listed.body).not.toContain('account');
  });

  it('rejects non-admins before employee service access', async () => {
    const privateEmployee = makeEmployee({
      id: OTHER_EMPLOYEE_ID,
      nik: 'NIK-PRIVATE-002',
      fullName: 'Data Profil Karyawan Lain',
    });
    const { app, serviceCalls } = await makeRouteApp([makeEmployee(), privateEmployee]);
    const deniedResponses = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/v1/admin/employees',
        headers: { 'x-test-role': UserRole.EMPLOYEE },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}`,
        headers: { 'x-test-role': UserRole.EMPLOYEE },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}`,
        headers: { ...adminHeaders(), 'x-test-role': UserRole.EMPLOYEE },
        payload: { fullName: 'Diubah tanpa izin' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}/deactivate`,
        headers: { ...adminHeaders(), 'x-test-role': UserRole.EMPLOYEE },
      }),
    ]);

    for (const response of deniedResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('NIK-PRIVATE-002');
      expect(response.body).not.toContain('Data Profil Karyawan Lain');
    }
    expect(serviceCalls).toEqual({ list: 0, get: 0, create: 0, update: 0, deactivate: 0 });
  });

  it('rejects a Supervisor on every available Admin-only employee operation before service access', async () => {
    const privateEmployee = {
      ...makeEmployee({
        id: OTHER_EMPLOYEE_ID,
        nik: 'SENTINEL_SUPERVISOR_NIK',
        fullName: 'SENTINEL_SUPERVISOR_NAME',
      }),
      passwordHash: 'SENTINEL_EMPLOYEE_PASSWORD_HASH',
      account: {
        username: 'SENTINEL_EMPLOYEE_ACCOUNT',
        passwordHash: 'SENTINEL_ACCOUNT_PASSWORD_HASH',
      },
    } as EmployeeRecord;
    const { app, rows, events, serviceCalls } = await makeRouteApp([
      makeEmployee(),
      privateEmployee,
    ]);
    const headers = { origin: ORIGIN, 'x-test-role': UserRole.SUPERVISOR };
    const rowsBefore = structuredClone(rows);
    const deniedResponses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/admin/employees', headers }),
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}`,
        headers,
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/employees',
        headers,
        payload: {
          nik: 'SENTINEL_SUPERVISOR_CREATE_NIK',
          fullName: 'SENTINEL_SUPERVISOR_CREATE_NAME',
          position: 'Staff',
          employmentDate: '2025-06-07',
        },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}`,
        headers,
        payload: { fullName: 'SENTINEL_SUPERVISOR_UPDATED_NAME' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/employees/${OTHER_EMPLOYEE_ID}/deactivate`,
        headers,
      }),
    ]);

    for (const response of deniedResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
      for (const sentinel of [
        'SENTINEL_SUPERVISOR_NIK',
        'SENTINEL_SUPERVISOR_NAME',
        'SENTINEL_SUPERVISOR_CREATE_NIK',
        'SENTINEL_SUPERVISOR_CREATE_NAME',
        'SENTINEL_SUPERVISOR_UPDATED_NAME',
        'SENTINEL_EMPLOYEE_PASSWORD_HASH',
        'SENTINEL_EMPLOYEE_ACCOUNT',
        'SENTINEL_ACCOUNT_PASSWORD_HASH',
      ]) {
        expect(response.body).not.toContain(sentinel);
      }
    }
    expect(serviceCalls).toEqual({ list: 0, get: 0, create: 0, update: 0, deactivate: 0 });
    expect(rows).toEqual(rowsBefore);
    expect(events).toEqual([]);
  });

  it('rejects invalid IDs and strict payloads', async () => {
    const { app } = await makeRouteApp([makeEmployee()]);
    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/employees/not-a-uuid',
      headers: adminHeaders(),
    });
    const invalidPayload = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: adminHeaders(),
      payload: { nik: 'NIK-002', fullName: 'Nama Baru', accountId: EMPLOYEE_ACCOUNT_ID },
    });

    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.headers['cache-control']).toBe('no-store');
    expect(invalidPayload.statusCode).toBe(400);
    expect(invalidPayload.json()).toMatchObject({ code: 'INVALID_EMPLOYEE_INPUT' });
    expect(invalidPayload.headers['cache-control']).toBe('no-store');
  });

  it('creates, patches, and soft-deactivates employees with the expected statuses', async () => {
    const { app, rows, events } = await makeRouteApp([makeEmployee()]);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: adminHeaders(),
      payload: {
        nik: 'NIK-002',
        fullName: 'Karyawan Dua',
        position: 'Kasir',
        employmentDate: '2025-06-07',
      },
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/employees/${EMPLOYEE_ID}`,
      headers: adminHeaders(),
      payload: { fullName: 'Nama Diperbarui' },
    });
    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/employees/${EMPLOYEE_ID}/deactivate`,
      headers: adminHeaders(),
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.json()).toMatchObject({ nik: 'NIK-002', status: EmployeeStatus.ACTIVE });
    expect(patched.statusCode).toBe(200);
    expect(patched.headers['cache-control']).toBe('no-store');
    expect(patched.json()).toMatchObject({ fullName: 'Nama Diperbarui' });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.headers['cache-control']).toBe('no-store');
    expect(deactivated.json()).toMatchObject({ status: EmployeeStatus.INACTIVE });
    expect(rows).toHaveLength(2);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.clientIp).toBe('127.0.0.1');
      expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('requires the configured origin for writes', async () => {
    const { app, rows } = await makeRouteApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: { 'x-test-role': UserRole.ADMIN, origin: 'https://attacker.example' },
      payload: { nik: 'NIK-003', fullName: 'Tidak Dibuat' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(rows).toHaveLength(0);
  });
});
