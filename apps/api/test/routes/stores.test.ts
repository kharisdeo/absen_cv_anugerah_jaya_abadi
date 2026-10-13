import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import { StoreService } from '../../src/modules/store/index.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';
import {
  ADMIN_ID,
  EMPLOYEE_ID,
  FakeStoreRepository,
  NOW,
  STORE_ID,
  makeEmployee,
  makeStore,
} from '../helpers/fake-store.js';

const EMPLOYEE_ACCOUNT_ID = 'b7fd4072-f499-4cd4-959a-730f9f037801';
const SUPERVISOR_ACCOUNT_ID = '95521a9e-38bb-461a-b7d0-6943c6902908';
const MISSING_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000777';
const ORIGIN = 'http://localhost:5173';
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function publicUser(role: UserRole): PublicAuthUser {
  const isAdmin = role === UserRole.ADMIN;
  const isSupervisor = role === UserRole.SUPERVISOR;
  return {
    id: isAdmin ? ADMIN_ID : isSupervisor ? SUPERVISOR_ACCOUNT_ID : EMPLOYEE_ACCOUNT_ID,
    username: isAdmin ? 'admin' : isSupervisor ? 'supervisor' : 'employee',
    role,
    employeeId: isAdmin ? null : EMPLOYEE_ID,
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
      deviceBindingId: role === UserRole.ADMIN ? null : '00000000-0000-4000-8000-000000000002',
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `stores-test-session-${role}`,
      lastSeenAt: NOW,
    },
  };
}

async function makeHarness() {
  const repository = new FakeStoreRepository([makeStore()]);
  const events: RecordAuditEventInput[] = [];
  const service = new StoreService(repository, {
    async record(event) {
      events.push(event);
      return {} as never;
    },
  });
  const serviceCalls = {
    list: 0,
    get: 0,
    create: 0,
    update: 0,
    deactivate: 0,
    listAssignments: 0,
    assignEmployee: 0,
    removeEmployee: 0,
  };
  const trackedService = {
    list: (...args: Parameters<StoreService['list']>) => {
      serviceCalls.list += 1;
      return service.list(...args);
    },
    get: (...args: Parameters<StoreService['get']>) => {
      serviceCalls.get += 1;
      return service.get(...args);
    },
    create: (...args: Parameters<StoreService['create']>) => {
      serviceCalls.create += 1;
      return service.create(...args);
    },
    update: (...args: Parameters<StoreService['update']>) => {
      serviceCalls.update += 1;
      return service.update(...args);
    },
    deactivate: (...args: Parameters<StoreService['deactivate']>) => {
      serviceCalls.deactivate += 1;
      return service.deactivate(...args);
    },
    listAssignments: (...args: Parameters<StoreService['listAssignments']>) => {
      serviceCalls.listAssignments += 1;
      return service.listAssignments(...args);
    },
    assignEmployee: (...args: Parameters<StoreService['assignEmployee']>) => {
      serviceCalls.assignEmployee += 1;
      return service.assignEmployee(...args);
    },
    removeEmployee: (...args: Parameters<StoreService['removeEmployee']>) => {
      serviceCalls.removeEmployee += 1;
      return service.removeEmployee(...args);
    },
  } as unknown as StoreService;
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role =
        input.identifier === 'admin'
          ? UserRole.ADMIN
          : input.identifier === 'supervisor'
            ? UserRole.SUPERVISOR
            : UserRole.EMPLOYEE;
      const cookieToken = `store-route-token-${role}`;
      sessions.set(cookieToken, session(role));
      return { cookieToken, user: publicUser(role) };
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
    cookieSecret: 'store-route-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({ logger: false, auth, stores: { service: trackedService } });
  openApps.push(app);
  return { app, repository, events, serviceCalls };
}

async function login(app: FastifyInstance, role: UserRole): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: {
      identifier:
        role === UserRole.ADMIN
          ? 'admin'
          : role === UserRole.SUPERVISOR
            ? 'supervisor'
            : 'employee',
      password: 'test-password',
    },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  expect(cookie).toBeTruthy();
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(';', 1)[0]!;
}

describe('store admin routes', () => {
  it('requires authentication and Admin role on read and write, with no-store errors', async () => {
    const { app, events } = await makeHarness();
    const anonymousRead = await app.inject({ method: 'GET', url: '/api/v1/admin/stores' });
    const anonymousWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers: { origin: ORIGIN },
      payload: { name: 'Baru', latitude: 0, longitude: 0 },
    });
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const forbiddenRead = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stores',
      headers: { cookie: employeeCookie },
    });
    const forbiddenWrite = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/stores/${STORE_ID}/assignments/${EMPLOYEE_ID}`,
      headers: { cookie: employeeCookie, origin: ORIGIN },
    });
    const forbiddenRadiusChange = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers: { cookie: employeeCookie, origin: ORIGIN },
      payload: { radiusMeters: 500 },
    });

    for (const response of [
      anonymousRead,
      anonymousWrite,
      forbiddenRead,
      forbiddenWrite,
      forbiddenRadiusChange,
    ]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(anonymousRead.statusCode).toBe(401);
    expect(anonymousWrite.statusCode).toBe(401);
    expect(forbiddenRead.statusCode).toBe(403);
    expect(forbiddenWrite.statusCode).toBe(403);
    expect(forbiddenRadiusChange.statusCode).toBe(403);
    expect(forbiddenRadiusChange.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(events).toHaveLength(0);
  });

  it('denies Supervisor store reads, writes, radius changes, and employee assignments before service access', async () => {
    const { app, repository, events, serviceCalls } = await makeHarness();
    const privateStore = makeStore({
      name: 'SENTINEL_PRIVATE_STORE_NAME',
      latitude: -6.123456,
      longitude: 106.123456,
      radiusMeters: 15,
    });
    const privateEmployee = makeEmployee({
      nik: 'SENTINEL_PRIVATE_EMPLOYEE_NIK',
      fullName: 'SENTINEL_PRIVATE_EMPLOYEE_NAME',
    });
    repository.stores.set(STORE_ID, privateStore);
    repository.employees.set(EMPLOYEE_ID, privateEmployee);
    repository.assignments.set(`${STORE_ID}:${EMPLOYEE_ID}`, {
      storeId: STORE_ID,
      employeeId: EMPLOYEE_ID,
      assignedByUserAccountId: ADMIN_ID,
      assignedAt: new Date(NOW),
      employee: privateEmployee,
    });

    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const headers = { cookie: supervisorCookie, origin: ORIGIN };
    const stateBefore = {
      stores: structuredClone([...repository.stores.entries()]),
      employees: structuredClone([...repository.employees.entries()]),
      assignments: structuredClone([...repository.assignments.entries()]),
      createInputs: structuredClone(repository.createInputs),
      updateInputs: structuredClone(repository.updateInputs),
      hardDeleteCount: repository.hardDeleteCount,
    };
    const deniedResponses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/admin/stores', headers }),
      app.inject({ method: 'GET', url: `/api/v1/admin/stores/${STORE_ID}`, headers }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/stores',
        headers,
        payload: {
          name: 'SENTINEL_SUPERVISOR_CREATED_STORE',
          latitude: -6.234567,
          longitude: 106.234567,
          radiusMeters: 20,
        },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/stores/${STORE_ID}`,
        headers,
        payload: {
          name: 'SENTINEL_SUPERVISOR_UPDATED_STORE',
          latitude: -6.345678,
          longitude: 106.345678,
          radiusMeters: 500,
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/stores/${STORE_ID}/deactivate`,
        headers,
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/stores/${STORE_ID}/assignments`,
        headers,
      }),
      app.inject({
        method: 'PUT',
        url: `/api/v1/admin/stores/${STORE_ID}/assignments/${EMPLOYEE_ID}`,
        headers,
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/stores/${STORE_ID}/assignments/${EMPLOYEE_ID}`,
        headers,
      }),
    ]);

    for (const response of deniedResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
      for (const sentinel of [
        'SENTINEL_PRIVATE_STORE_NAME',
        'SENTINEL_PRIVATE_EMPLOYEE_NIK',
        'SENTINEL_PRIVATE_EMPLOYEE_NAME',
        'SENTINEL_SUPERVISOR_CREATED_STORE',
        'SENTINEL_SUPERVISOR_UPDATED_STORE',
        String(privateStore.latitude),
        String(privateStore.longitude),
        '-6.234567',
        '106.234567',
        '-6.345678',
        '106.345678',
      ]) {
        expect(response.body).not.toContain(sentinel);
      }
    }
    expect(serviceCalls).toEqual({
      list: 0,
      get: 0,
      create: 0,
      update: 0,
      deactivate: 0,
      listAssignments: 0,
      assignEmployee: 0,
      removeEmployee: 0,
    });
    expect(repository.stores).toEqual(new Map(stateBefore.stores));
    expect(repository.employees).toEqual(new Map(stateBefore.employees));
    expect(repository.assignments).toEqual(new Map(stateBefore.assignments));
    expect(repository.createInputs).toEqual(stateBefore.createInputs);
    expect(repository.updateInputs).toEqual(stateBefore.updateInputs);
    expect(repository.hardDeleteCount).toBe(stateBefore.hardDeleteCount);
    expect(events).toEqual([]);
  });

  it('requires exact Origin on writes and marks CSRF errors no-store', async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers: { cookie },
      payload: { name: 'Baru', latitude: 0, longitude: 0 },
    });
    const wrongOrigin = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers: { cookie, origin: 'https://attacker.example' },
      payload: { name: 'Tidak boleh' },
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
    expect(wrongOrigin.headers['cache-control']).toBe('no-store');
    expect(missingOrigin.headers['cache-control']).toBe('no-store');
  });

  it('lists, creates, details, and updates safe store DTOs with schema defaults and no-store', async () => {
    const { app, events } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers,
      payload: { name: 'Toko Baru', address: null, latitude: -6.2, longitude: 106.816667 },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/admin/stores', headers });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers,
    });
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers,
      payload: { latitude: -6.123456, longitude: 106.123456, radiusMeters: 25 },
    });
    const expectedKeys = [
      'accuracyLimitMeters',
      'address',
      'createdAt',
      'id',
      'isActive',
      'latitude',
      'longitude',
      'name',
      'radiusMeters',
      'updatedAt',
      'wifiPublicIp',
    ].sort();

    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.json()).toMatchObject({
      radiusMeters: 10,
      accuracyLimitMeters: 30,
      isActive: true,
    });
    expect(Object.keys(created.json()).sort()).toEqual(expectedKeys);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(updated.statusCode).toBe(200);
    expect(updated.headers['cache-control']).toBe('no-store');
    expect(updated.json()).toMatchObject({
      latitude: -6.123456,
      longitude: 106.123456,
      radiusMeters: 25,
    });
    expect(events.map((event) => event.action)).toEqual(['store.create', 'store.update']);
    expect(events[1]).toMatchObject({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      before: { latitude: -6.2, longitude: 106.816666, radiusMeters: 10 },
      after: { latitude: -6.123456, longitude: 106.123456, radiusMeters: 25 },
      clientIp: '127.0.0.1',
    });
    expect(events[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('does not assume store names are unique and rejects malformed IDs or strict payload violations', async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers,
      payload: { name: 'Nama Sama', latitude: 1, longitude: 2 },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers,
      payload: { name: 'Nama Sama', latitude: 3, longitude: 4 },
    });
    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stores/not-a-uuid',
      headers,
    });
    const extraField = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers,
      payload: { name: 'Invalid', latitude: 0, longitude: 0, userId: ADMIN_ID },
    });
    const invalidCoordinate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers,
      payload: { latitude: 90.000001 },
    });
    const invalidIp = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/${STORE_ID}`,
      headers,
      payload: { wifiPublicIp: 'not-an-ip' },
    });
    const missingStore = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stores/00000000-0000-4000-8000-000000000777',
      headers,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(invalidId.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
    expect(invalidCoordinate.statusCode).toBe(400);
    expect(invalidIp.statusCode).toBe(400);
    expect(missingStore.statusCode).toBe(404);
    for (const response of [invalidId, extraField, invalidCoordinate, invalidIp, missingStore]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('soft-deactivates a store without deleting it', async () => {
    const { app, repository, events } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/stores/${STORE_ID}/deactivate`,
      headers: { cookie, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ id: STORE_ID, isActive: false });
    expect(repository.stores.has(STORE_ID)).toBe(true);
    expect(repository.hardDeleteCount).toBe(0);
    expect(events[0]).toMatchObject({
      action: 'store.deactivate',
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  it('lists assignments, assigns/removes idempotently, and never duplicates no-op audit', async () => {
    const { app, events } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const assignmentUrl = `/api/v1/admin/stores/${STORE_ID}/assignments/${EMPLOYEE_ID}`;
    const firstPut = await app.inject({ method: 'PUT', url: assignmentUrl, headers });
    const repeatedPut = await app.inject({ method: 'PUT', url: assignmentUrl, headers });
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/stores/${STORE_ID}/assignments`,
      headers,
    });
    const firstDelete = await app.inject({ method: 'DELETE', url: assignmentUrl, headers });
    const repeatedDelete = await app.inject({ method: 'DELETE', url: assignmentUrl, headers });

    expect(firstPut.statusCode).toBe(200);
    expect(firstPut.headers['cache-control']).toBe('no-store');
    expect(firstPut.json()).toMatchObject({
      storeId: STORE_ID,
      employeeId: EMPLOYEE_ID,
      employee: { id: EMPLOYEE_ID, nik: 'AJ-001', fullName: 'Karyawan Satu' },
    });
    expect(repeatedPut.json().assignedAt).toBe(firstPut.json().assignedAt);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json()).toHaveLength(1);
    expect(firstDelete.statusCode).toBe(204);
    expect(repeatedDelete.statusCode).toBe(204);
    expect(firstDelete.headers['cache-control']).toBe('no-store');
    expect(repeatedDelete.headers['cache-control']).toBe('no-store');
    expect(events.map((event) => event.action)).toEqual([
      'store.employee_assigned',
      'store.employee_unassigned',
    ]);
    expect(events[0]).toMatchObject({
      actor: { userAccountId: ADMIN_ID, role: UserRole.ADMIN },
      clientIp: '127.0.0.1',
    });
    expect(events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(events[1]).toMatchObject({ before: { storeId: STORE_ID, employeeId: EMPLOYEE_ID } });
  });

  it('rejects assignment to a missing employee or store and malformed assignment payloads', async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const headers = { cookie, origin: ORIGIN };
    const missingEmployee = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/stores/${STORE_ID}/assignments/${MISSING_EMPLOYEE_ID}`,
      headers,
    });
    const invalidAssignmentId = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/stores/${STORE_ID}/assignments/invalid`,
      headers,
    });
    const extraPayload = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/stores/${STORE_ID}/assignments/${EMPLOYEE_ID}`,
      headers,
      payload: { employeeId: EMPLOYEE_ID },
    });
    const missingStore = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stores/00000000-0000-4000-8000-000000000777/assignments',
      headers,
    });

    expect(missingEmployee.statusCode).toBe(404);
    expect(invalidAssignmentId.statusCode).toBe(400);
    expect(extraPayload.statusCode).toBe(400);
    expect(missingStore.statusCode).toBe(404);
    for (const response of [missingEmployee, invalidAssignmentId, extraPayload, missingStore]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
});
