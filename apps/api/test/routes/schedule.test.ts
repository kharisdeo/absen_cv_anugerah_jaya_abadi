import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  ScheduleService,
  type ScheduleRepository,
  type WorkShiftRecord,
} from '../../src/modules/schedule/index.js';
import type { AuthenticatedSession, PublicAuthUser } from '../../src/modules/auth/contracts.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000002';
const SHIFT_ID = '00000000-0000-4000-8000-000000000003';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000005';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000006';
const HOLIDAY_ID = '00000000-0000-4000-8000-000000000007';
const STORE_ID = '00000000-0000-4000-8000-000000000008';
const SENTINEL = 'SENTINEL_SUPERVISOR_SCHEDULE_PRIVATE_DATA';
const ORIGIN = 'http://localhost:5173';
const openApps: FastifyInstance[] = [];

function makeShift(overrides: Partial<WorkShiftRecord> = {}): WorkShiftRecord {
  return {
    id: SHIFT_ID,
    name: 'Pagi',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    lateToleranceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function publicUser(role: UserRole): PublicAuthUser {
  const isAdmin = role === UserRole.ADMIN;
  const isSupervisor = role === UserRole.SUPERVISOR;
  return {
    id: isAdmin ? ADMIN_ID : isSupervisor ? SUPERVISOR_ID : EMPLOYEE_ID,
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
      deviceBindingId: role === UserRole.ADMIN ? null : '00000000-0000-4000-8000-000000000004',
      deviceBindingStatus: user.deviceBindingStatus,
      mustChangePassword: false,
      consentRequired: false,
      sessionId: `schedule-test-session-${role}`,
      lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
    },
  };
}

async function makeHarness() {
  const events: RecordAuditEventInput[] = [];
  const auditCalls: RecordAuditEventInput[] = [];
  const serviceCalls: string[] = [];
  const repositoryCalls: string[] = [];
  const created: WorkShiftRecord[] = [];
  const repository = new Proxy(
    {
      async listShifts() {
        return created;
      },
      async createShift(data: {
        name: string;
        startTime: string;
        endTime: string;
        workDays: readonly number[];
        breakMinutes?: number;
        lateToleranceMinutes?: number;
        isActive?: boolean;
      }) {
        const row = makeShift({
          ...data,
          id: SHIFT_ID,
          breakMinutes: data.breakMinutes ?? 0,
          lateToleranceMinutes: data.lateToleranceMinutes ?? 0,
          isActive: data.isActive ?? true,
          createdAt: new Date('2026-10-11T00:00:00.000Z'),
          updatedAt: new Date('2026-10-11T00:00:00.000Z'),
        });
        created.push(row);
        return row;
      },
    },
    {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value === 'function') {
          return async (...args: unknown[]) => {
            repositoryCalls.push(String(property));
            return Reflect.apply(value, target, args);
          };
        }
        return async () => {
          repositoryCalls.push(String(property));
          throw new Error(`Unexpected ScheduleRepository call: ${String(property)}`);
        };
      },
    },
  ) as unknown as ScheduleRepository;
  const service = new ScheduleService(repository, {
    async record(event) {
      auditCalls.push(event);
      events.push(event);
      return {} as never;
    },
  });
  const trackedService = new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        serviceCalls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
  const sessions = new Map<string, AuthenticatedSession>();
  const authService = {
    async login(input: { identifier: string }) {
      const role =
        input.identifier === 'admin'
          ? UserRole.ADMIN
          : input.identifier === 'supervisor'
            ? UserRole.SUPERVISOR
            : UserRole.EMPLOYEE;
      const cookieToken = `schedule-route-token-${role}`;
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
    cookieSecret: 'schedule-route-test-cookie-signing-secret',
    secureCookies: false,
    allowedOrigin: ORIGIN,
    sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
  } satisfies AuthRoutesOptions;
  const app = await buildApp({ logger: false, auth, schedule: { service: trackedService } });
  openApps.push(app);
  return { app, events, auditCalls, serviceCalls, repositoryCalls, created };
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

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('schedule admin routes', () => {
  it('requires an authenticated Admin and applies no-store to denied responses', async () => {
    const { app, events, created } = await makeHarness();
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/shifts' });
    const anonymousWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { origin: ORIGIN },
      payload: { name: 'Pagi', startTime: '08:00', endTime: '17:00', workDays: [1, 2, 3, 4, 5] },
    });
    const employeeCookie = await login(app, UserRole.EMPLOYEE);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/shifts',
      headers: { cookie: employeeCookie },
    });
    const forbiddenShiftCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { origin: ORIGIN, cookie: employeeCookie },
      payload: {
        name: 'Infiltrasi',
        startTime: '08:00',
        endTime: '17:00',
        workDays: [1, 2, 3, 4, 5],
      },
    });
    const forbiddenAssignmentCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shift-assignments',
      headers: { origin: ORIGIN, cookie: employeeCookie },
      payload: {
        employeeId: EMPLOYEE_ID,
        workShiftId: SHIFT_ID,
        effectiveFrom: '2026-10-11',
      },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    for (const response of [
      anonymous,
      anonymousWrite,
      forbidden,
      forbiddenShiftCreate,
      forbiddenAssignmentCreate,
    ]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(anonymousWrite.statusCode).toBe(401);
    expect(forbiddenShiftCreate.statusCode).toBe(403);
    expect(forbiddenShiftCreate.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(forbiddenAssignmentCreate.statusCode).toBe(403);
    expect(forbiddenAssignmentCreate.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(created).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it.each([
    { name: 'lists shifts', method: 'GET', url: '/api/v1/admin/shifts' },
    { name: 'gets a shift', method: 'GET', url: `/api/v1/admin/shifts/${SHIFT_ID}` },
    {
      name: 'creates a shift',
      method: 'POST',
      url: '/api/v1/admin/shifts',
      payload: { name: SENTINEL, startTime: '08:00', endTime: '17:00', workDays: [1, 2, 3, 4, 5] },
    },
    {
      name: 'updates a shift',
      method: 'PATCH',
      url: `/api/v1/admin/shifts/${SHIFT_ID}`,
      payload: { name: SENTINEL },
    },
    {
      name: 'deactivates a shift',
      method: 'POST',
      url: `/api/v1/admin/shifts/${SHIFT_ID}/deactivate`,
      payload: {},
    },
    {
      name: 'lists shift assignments',
      method: 'GET',
      url: `/api/v1/admin/shift-assignments?employeeId=${EMPLOYEE_ID}&storeId=global&businessDate=2026-10-11`,
    },
    {
      name: 'gets a shift assignment',
      method: 'GET',
      url: `/api/v1/admin/shift-assignments/${ASSIGNMENT_ID}`,
    },
    {
      name: 'creates a shift assignment',
      method: 'POST',
      url: '/api/v1/admin/shift-assignments',
      payload: {
        employeeId: EMPLOYEE_ID,
        workShiftId: SHIFT_ID,
        storeId: STORE_ID,
        effectiveFrom: '2026-10-11',
      },
    },
    {
      name: 'updates a shift assignment',
      method: 'PATCH',
      url: `/api/v1/admin/shift-assignments/${ASSIGNMENT_ID}`,
      payload: { workShiftId: SHIFT_ID, storeId: STORE_ID, effectiveFrom: '2026-10-11' },
    },
    {
      name: 'deactivates a shift assignment',
      method: 'POST',
      url: `/api/v1/admin/shift-assignments/${ASSIGNMENT_ID}/deactivate`,
      payload: { effectiveTo: '2026-10-12' },
    },
    {
      name: 'lists holidays',
      method: 'GET',
      url: '/api/v1/admin/holidays?from=2026-10-11&to=2026-10-12&storeId=national',
    },
    { name: 'gets a holiday', method: 'GET', url: `/api/v1/admin/holidays/${HOLIDAY_ID}` },
    {
      name: 'creates a holiday',
      method: 'POST',
      url: '/api/v1/admin/holidays',
      payload: { storeId: STORE_ID, holidayDate: '2026-10-11', description: SENTINEL },
    },
    {
      name: 'updates a holiday',
      method: 'PATCH',
      url: `/api/v1/admin/holidays/${HOLIDAY_ID}`,
      payload: { holidayDate: '2026-10-12', description: SENTINEL },
    },
    { name: 'deletes a holiday', method: 'DELETE', url: `/api/v1/admin/holidays/${HOLIDAY_ID}` },
  ] as const)('denies Supervisor who $name before schedule operations', async (route) => {
    const { app, events, auditCalls, serviceCalls, repositoryCalls, created } = await makeHarness();
    const supervisorCookie = await login(app, UserRole.SUPERVISOR);
    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers: { origin: ORIGIN, cookie: supervisorCookie },
      ...('payload' in route ? { payload: route.payload } : {}),
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(response.body).not.toContain(SENTINEL);
    expect(serviceCalls).toEqual([]);
    expect(repositoryCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
    expect(events).toEqual([]);
    expect(created).toEqual([]);
  });

  it('checks exact Origin, requires explicit workdays, and returns audited no-store shift DTOs', async () => {
    const { app, events } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { cookie },
      payload: { name: 'Pagi', startTime: '08:00', endTime: '17:00', workDays: [1, 2] },
    });
    const missingDays = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { cookie, origin: ORIGIN },
      payload: { name: 'Pagi', startTime: '08:00', endTime: '17:00' },
    });
    const emptyDays = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { cookie, origin: ORIGIN },
      payload: { name: 'Pagi', startTime: '08:00', endTime: '17:00', workDays: [] },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/shifts',
      headers: { cookie, origin: ORIGIN },
      payload: {
        name: 'Pagi',
        startTime: '08:00',
        endTime: '17:00',
        workDays: [1, 2, 3, 4, 5],
      },
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.headers['cache-control']).toBe('no-store');
    expect(missingDays.statusCode).toBe(400);
    expect(emptyDays.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.json()).toMatchObject({
      id: SHIFT_ID,
      startTime: '08:00:00',
      endTime: '17:00:00',
      workDays: [1, 2, 3, 4, 5],
    });
    expect(events.map((event) => event.action)).toEqual(['schedule.shift.create']);
  });

  it('rejects calendar-invalid date filters before querying data', async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, UserRole.ADMIN);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/holidays?from=2026-02-30',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'INVALID_SCHEDULE_INPUT' });
  });
});
