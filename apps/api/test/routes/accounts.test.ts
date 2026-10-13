import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { AccountStatus, DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog } from '../../src/generated/prisma/client.js';
import { AccountService } from '../../src/modules/account/index.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import type {
  AccountCreateData,
  AccountDto,
  AccountEmployeeLink,
  AccountMutation,
  AccountRepository,
  AccountUpdateData,
} from '../../src/modules/account/index.js';
import type {
  AuthAccount,
  AuthRepository,
  AuthSession,
  AuthSessionWithAccount,
  CompleteLoginInput,
  CompleteLoginResult,
  LoginAttemptUpdate,
  PasswordResetMutation,
  RotatePasswordInput,
} from '../../src/modules/auth/contracts.js';
import { AuthService } from '../../src/modules/auth/service.js';
import {
  createFakeDeviceBindingService,
  FakeDeviceBindingRepository,
} from '../helpers/fake-device-binding.js';

const ADMIN_ID = 'ac8fe71b-4807-421e-9738-0ae6fc9b5d42';
const SUPERVISOR_ID = '0e2b0a21-7b3c-48e7-a327-886c77d91593';
const EMPLOYEE_ID = 'b48caa23-ae55-4413-a2b3-6a53788466df';
const EMPLOYEE_PROFILE_ID = '77a5fe3a-4a02-46e8-b9ca-bc143c533117';
const CREATED_ID = 'd33031af-934b-4a5a-a917-87540cf99b4d';
const ORIGIN = 'http://localhost:5173';
const TEMPORARY_PASSWORD = 'one-time-account-password';
const NOW = new Date('2026-10-11T02:00:00.000Z');

function makeAccountDto(
  values: Partial<AccountDto> & Pick<AccountDto, 'id' | 'username'>,
): AccountDto {
  return {
    id: values.id,
    username: values.username,
    role: values.role ?? UserRole.EMPLOYEE,
    status: values.status ?? AccountStatus.ACTIVE,
    employeeId: values.employeeId ?? null,
    mustChangePassword: values.mustChangePassword ?? false,
    createdAt: values.createdAt ?? NOW,
    updatedAt: values.updatedAt ?? NOW,
  };
}

function makeAuthAccount(id: string, username: string, role: UserRole): AuthAccount {
  return {
    id,
    username,
    employeeNik: null,
    passwordHash: `hash:${username}-password`,
    role,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    employeeId: role === UserRole.ADMIN ? null : EMPLOYEE_PROFILE_ID,
  };
}

class InjectAuthRepository implements AuthRepository {
  readonly accounts = new Map<string, AuthAccount>([
    [ADMIN_ID, makeAuthAccount(ADMIN_ID, 'admin', UserRole.ADMIN)],
    [SUPERVISOR_ID, makeAuthAccount(SUPERVISOR_ID, 'supervisor', UserRole.SUPERVISOR)],
    [EMPLOYEE_ID, makeAuthAccount(EMPLOYEE_ID, 'employee', UserRole.EMPLOYEE)],
  ]);
  readonly sessions = new Map<string, AuthSession>();

  constructor(private readonly deviceBindings: FakeDeviceBindingRepository) {}

  async findAccountsByIdentifier(identifier: string): Promise<readonly AuthAccount[]> {
    return [...this.accounts.values()].filter(
      (account) => account.username === identifier || account.employeeNik === identifier,
    );
  }

  async recordFailedLogin(
    accountId: string,
    now: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<LoginAttemptUpdate> {
    const account = this.accounts.get(accountId);
    if (!account) return { failedLoginAttempts: 0, lockedUntil: null };
    const failedLoginAttempts = account.failedLoginAttempts + 1;
    const lockedUntil =
      failedLoginAttempts >= failureLimit ? new Date(now.getTime() + lockDurationMs) : null;
    this.accounts.set(accountId, { ...account, failedLoginAttempts, lockedUntil });
    return { failedLoginAttempts, lockedUntil };
  }

  async completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult | null> {
    const account = this.accounts.get(input.accountId);
    if (!account || account.passwordHash !== input.expectedPasswordHash) return null;
    let deviceBindingStatus: DeviceBindingStatus | null = null;
    if (account.role !== UserRole.ADMIN) {
      const binding = input.deviceBindingId
        ? this.deviceBindings.findById(input.deviceBindingId)
        : null;
      if (
        !account.employeeId ||
        !binding ||
        binding.employeeId !== account.employeeId ||
        binding.status === DeviceBindingStatus.REVOKED
      ) {
        return null;
      }
      deviceBindingStatus = binding.status;
    } else if (input.deviceBindingId !== null) {
      return null;
    }
    const updated = {
      ...account,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: input.now,
    };
    this.accounts.set(account.id, updated);
    const session = this.createSession(
      input.accountId,
      input.tokenHash,
      input.now,
      input.deviceBindingId,
    );
    return { account: updated, session, deviceBindingStatus };
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionWithAccount | null> {
    const session = [...this.sessions.values()].find((item) => item.tokenHash === tokenHash);
    const account = session ? this.accounts.get(session.userAccountId) : undefined;
    const binding = session?.deviceBindingId
      ? this.deviceBindings.findById(session.deviceBindingId)
      : null;
    return session && account
      ? { session, account, deviceBindingStatus: binding?.status ?? null }
      : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) return false;
    this.sessions.set(sessionId, { ...session, lastSeenAt: now, updatedAt: now });
    return true;
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) {
      this.sessions.set(sessionId, { ...session, revokedAt: now, updatedAt: now });
    }
  }

  async revokeAccountSessions(accountId: string, now: Date): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userAccountId === accountId && !session.revokedAt) {
        this.sessions.set(id, { ...session, revokedAt: now, updatedAt: now });
      }
    }
  }

  async findAccountById(accountId: string): Promise<AuthAccount | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async resetPassword(
    accountId: string,
    newPasswordHash: string,
    _now: Date,
  ): Promise<PasswordResetMutation | null> {
    void _now;
    const account = this.accounts.get(accountId);
    if (!account) return null;
    const updated = {
      ...account,
      passwordHash: newPasswordHash,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    this.accounts.set(accountId, updated);
    return { before: account, after: updated };
  }

  async rotatePassword(input: RotatePasswordInput): Promise<CompleteLoginResult | null> {
    const account = this.accounts.get(input.accountId);
    if (!account || account.passwordHash !== input.expectedPasswordHash) return null;
    let deviceBindingStatus: DeviceBindingStatus | null = null;
    if (account.role === UserRole.ADMIN) {
      if (input.deviceBindingId !== null) return null;
    } else {
      if (!account.employeeId || input.deviceBindingId === null) return null;
      const binding = this.deviceBindings.findById(input.deviceBindingId);
      if (
        !binding ||
        binding.employeeId !== account.employeeId ||
        binding.status === DeviceBindingStatus.REVOKED
      ) {
        return null;
      }
      deviceBindingStatus = binding.status;
    }
    const updated = {
      ...account,
      passwordHash: input.newPasswordHash,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    this.accounts.set(account.id, updated);
    await this.revokeAccountSessions(account.id, input.now);
    return {
      account: updated,
      session: this.createSession(account.id, input.tokenHash, input.now, input.deviceBindingId),
      deviceBindingStatus,
    };
  }

  private createSession(
    accountId: string,
    tokenHash: string,
    now: Date,
    deviceBindingId: string | null,
  ): AuthSession {
    const session: AuthSession = {
      id: `session-${this.sessions.size + 1}`,
      userAccountId: accountId,
      deviceBindingId,
      tokenHash,
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }
}

class InjectAccountRepository implements AccountRepository {
  readonly rows = new Map<string, AccountDto>([
    [ADMIN_ID, makeAccountDto({ id: ADMIN_ID, username: 'admin', role: UserRole.ADMIN })],
    [
      SUPERVISOR_ID,
      makeAccountDto({
        id: SUPERVISOR_ID,
        username: 'SENTINEL_PRIVATE_SUPERVISOR_ACCOUNT',
        role: UserRole.SUPERVISOR,
        employeeId: EMPLOYEE_PROFILE_ID,
      }),
    ],
    [EMPLOYEE_ID, makeAccountDto({ id: EMPLOYEE_ID, username: 'employee' })],
  ]);
  readonly persistedHashes: string[] = [];
  readonly calls: string[] = [];
  private createdCount = 0;

  async list(): Promise<readonly AccountDto[]> {
    this.calls.push('list');
    return [...this.rows.values()];
  }

  async findById(id: string): Promise<AccountDto | null> {
    this.calls.push('findById');
    return this.rows.get(id) ?? null;
  }

  async findByUsername(username: string): Promise<AccountDto | null> {
    this.calls.push('findByUsername');
    return [...this.rows.values()].find((account) => account.username === username) ?? null;
  }

  async findEmployeeByNik(): Promise<AccountEmployeeLink | null> {
    this.calls.push('findEmployeeByNik');
    return null;
  }

  async findEmployeeById(): Promise<AccountEmployeeLink | null> {
    this.calls.push('findEmployeeById');
    return null;
  }

  async create(data: AccountCreateData): Promise<AccountDto> {
    this.calls.push('create');
    this.createdCount += 1;
    const id = this.createdCount === 1 ? CREATED_ID : 'e33031af-934b-4a5a-a917-87540cf99b4d';
    const account = makeAccountDto({
      id,
      username: data.username,
      role: data.role,
      status: data.status,
      employeeId: data.employeeId,
      mustChangePassword: true,
      createdAt: new Date(NOW.getTime() + this.createdCount),
      updatedAt: new Date(NOW.getTime() + this.createdCount),
    });
    this.rows.set(id, account);
    this.persistedHashes.push(data.passwordHash);
    return account;
  }

  async updateWithAdminFloor(id: string, data: AccountUpdateData): Promise<AccountMutation | null> {
    this.calls.push('updateWithAdminFloor');
    return this.mutate(id, data);
  }

  async deactivateWithAdminFloor(id: string): Promise<AccountMutation | null> {
    this.calls.push('deactivateWithAdminFloor');
    return this.mutate(id, { status: AccountStatus.INACTIVE });
  }

  private async mutate(id: string, data: AccountUpdateData): Promise<AccountMutation | null> {
    const before = this.rows.get(id);
    if (!before) return null;
    const changed = Object.entries(data).some(
      ([key, value]) => before[key as keyof AccountDto] !== value,
    );
    const after = changed
      ? { ...before, ...data, updatedAt: new Date(before.updatedAt.getTime() + 1) }
      : before;
    this.rows.set(id, after);
    return { before, after, changed };
  }
}

function makeAccountService(repository = new InjectAccountRepository()): {
  service: AccountService;
  repository: InjectAccountRepository;
  auditEvents: RecordAuditEventInput[];
  calls: { list: number; get: number; create: number; update: number; deactivate: number };
} {
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    async record(event: RecordAuditEventInput) {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  const service = new AccountService({
    repository,
    audit,
    passwordHasher: { hash: async (password) => `argon2id-test:${password}` },
    createTemporaryPassword: () => TEMPORARY_PASSWORD,
  });
  const calls = { list: 0, get: 0, create: 0, update: 0, deactivate: 0 };
  const trackedService = {
    list: (...args: Parameters<AccountService['list']>) => {
      calls.list += 1;
      return service.list(...args);
    },
    get: (...args: Parameters<AccountService['get']>) => {
      calls.get += 1;
      return service.get(...args);
    },
    create: (...args: Parameters<AccountService['create']>) => {
      calls.create += 1;
      return service.create(...args);
    },
    update: (...args: Parameters<AccountService['update']>) => {
      calls.update += 1;
      return service.update(...args);
    },
    deactivate: (...args: Parameters<AccountService['deactivate']>) => {
      calls.deactivate += 1;
      return service.deactivate(...args);
    },
  } as unknown as AccountService;
  return { service: trackedService, repository, auditEvents, calls };
}

function createHarness(options: { accountRateLimit?: number } = {}) {
  const bindingRepository = new FakeDeviceBindingRepository();
  const authRepository = new InjectAuthRepository(bindingRepository);
  let tokenNumber = 0;
  const audit = {
    async record() {
      return {} as AuditLog;
    },
  };
  const deviceBindings = createFakeDeviceBindingService(
    bindingRepository,
    audit,
    () => new Date(NOW),
  );
  const authService = new AuthService({
    repository: authRepository,
    passwordHasher: {
      hash: async (password) => `hash:${password}`,
      verify: async (hash, password) => hash === `hash:${password}`,
    },
    audit,
    dummyPasswordHash: 'hash:dummy',
    consentStatus: { isConsentRequired: async () => false },
    deviceBindings,
    now: () => new Date(NOW),
    createToken: () => `inject-token-${++tokenNumber}`,
  });
  const {
    service: accountService,
    repository,
    auditEvents: accountAuditEvents,
    calls: accountServiceCalls,
  } = makeAccountService();
  const appPromise = buildApp({
    logger: false,
    auth: {
      service: authService,
      cookieSecret: 'test-cookie-signing-secret-that-is-long-enough',
      secureCookies: false,
      allowedOrigin: ORIGIN,
      loginRateLimit: { max: 100, timeWindow: '1 minute' },
      sensitiveRateLimit: { max: options.accountRateLimit ?? 100, timeWindow: '1 minute' },
    },
    accounts: { service: accountService },
  });
  return { appPromise, repository, bindingRepository, accountServiceCalls, accountAuditEvents };
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: {
      identifier: username,
      password: `${username}-password`,
      ...(username === 'admin'
        ? {}
        : {
            deviceToken: 'QmFzZTY0VXJsRGV2aWNlVG9rZW5Gb3JVbml0VGVzdHM',
            deviceName: 'Test work phone',
          }),
    },
  });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.body}`);
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string | undefined;
  if (!cookie) throw new Error('Login did not set a session cookie.');
  return cookie.split(';', 1)[0]!;
}

async function loginAsSupervisor(
  app: FastifyInstance,
  bindingRepository: FakeDeviceBindingRepository,
): Promise<string> {
  await login(app, 'supervisor');
  const pendingBindings = await bindingRepository.listPending();
  expect(pendingBindings).toHaveLength(1);
  bindingRepository.setStatus(pendingBindings[0]!.id, DeviceBindingStatus.APPROVED);
  return login(app, 'supervisor');
}

describe('account routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('does not register the account API when auth is absent', async () => {
    const { service } = makeAccountService();
    const app = await buildApp({ logger: false, accounts: { service } });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/accounts' });

    expect(response.statusCode).toBe(404);
  });

  it('requires an authenticated session and rejects non-Admin roles', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);

    const noSession = await app.inject({ method: 'GET', url: '/api/v1/admin/accounts' });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.headers['cache-control']).toBe('no-store');

    const employeeCookie = await login(app, 'employee');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/accounts/${EMPLOYEE_ID}`,
      headers: { cookie: employeeCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
  });

  it('does not let an Employee create an Admin account or elevate an existing account', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    await login(app, 'employee');
    const pendingBindings = await harness.bindingRepository.listPending();
    expect(pendingBindings).toHaveLength(1);
    harness.bindingRepository.setStatus(pendingBindings[0]!.id, DeviceBindingStatus.APPROVED);
    const employeeCookie = await login(app, 'employee');
    const beforeCount = harness.repository.rows.size;
    const createAdmin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { origin: ORIGIN, cookie: employeeCookie },
      payload: { username: 'forged-admin', role: UserRole.ADMIN },
    });
    const elevateEmployee = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${EMPLOYEE_ID}`,
      headers: { origin: ORIGIN, cookie: employeeCookie },
      payload: { role: UserRole.ADMIN },
    });

    for (const response of [createAdmin, elevateEmployee]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(TEMPORARY_PASSWORD);
      expect(response.body).not.toContain('passwordHash');
    }
    expect(harness.repository.rows.size).toBe(beforeCount);
    expect(harness.repository.rows.get(EMPLOYEE_ID)?.role).toBe(UserRole.EMPLOYEE);
    expect(harness.repository.persistedHashes).toEqual([]);
  });

  it('denies Supervisor account reads and privilege mutations before service or repository access', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const supervisorCookie = await loginAsSupervisor(app, harness.bindingRepository);
    const headers = { origin: ORIGIN, cookie: supervisorCookie };
    const rowsBefore = structuredClone([...harness.repository.rows.entries()]);
    const deniedResponses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/admin/accounts', headers }),
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/accounts/${SUPERVISOR_ID}`,
        headers,
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers,
        payload: { username: 'SENTINEL_SUPERVISOR_CREATED_ADMIN', role: UserRole.ADMIN },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/accounts/${EMPLOYEE_ID}`,
        headers,
        payload: {
          username: 'SENTINEL_SUPERVISOR_ELEVATED_ACCOUNT',
          role: UserRole.ADMIN,
          status: AccountStatus.SUSPENDED,
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/accounts/${EMPLOYEE_ID}/deactivate`,
        headers,
      }),
    ]);

    for (const response of deniedResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.headers['cache-control']).toBe('no-store');
      for (const sentinel of [
        'SENTINEL_PRIVATE_SUPERVISOR_ACCOUNT',
        'SENTINEL_SUPERVISOR_CREATED_ADMIN',
        'SENTINEL_SUPERVISOR_ELEVATED_ACCOUNT',
        TEMPORARY_PASSWORD,
        'passwordHash',
        'hash:supervisor-password',
      ]) {
        expect(response.body).not.toContain(sentinel);
      }
    }
    expect(harness.accountServiceCalls).toEqual({
      list: 0,
      get: 0,
      create: 0,
      update: 0,
      deactivate: 0,
    });
    expect(harness.repository.calls).toEqual([]);
    expect([...harness.repository.rows.entries()]).toEqual(rowsBefore);
    expect(harness.repository.persistedHashes).toEqual([]);
    expect(harness.accountAuditEvents).toEqual([]);
  });

  it('rejects writes without the configured CSRF Origin and marks the error no-store', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const adminCookie = await login(app, 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
      payload: { username: 'new-user', role: UserRole.EMPLOYEE },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(harness.repository.rows.has(CREATED_ID)).toBe(false);
  });

  it('validates strict create, patch, and path inputs', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const adminCookie = await login(app, 'admin');
    const headers = { origin: ORIGIN, cookie: adminCookie };

    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers,
      payload: { username: 'new-user', role: UserRole.EMPLOYEE, ignored: true },
    });
    const invalidRole = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers,
      payload: { username: 'new-user', role: 'OWNER' },
    });
    const invalidPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${EMPLOYEE_ID}`,
      headers,
      payload: { employeeId: 'not-a-uuid' },
    });
    const invalidParams = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/accounts/not-a-uuid',
      headers,
      payload: { username: 'replacement' },
    });

    for (const response of [invalidCreate, invalidRole, invalidPatch, invalidParams]) {
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(harness.repository.rows.get(EMPLOYEE_ID)?.username).toBe('employee');
    expect(harness.repository.rows.has(CREATED_ID)).toBe(false);
  });

  it('returns the temporary password only from create and safe DTOs from read/update/deactivate', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const adminCookie = await login(app, 'admin');
    const headers = { origin: ORIGIN, cookie: adminCookie };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/accounts',
      headers,
      payload: { username: 'new-user', role: UserRole.EMPLOYEE },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const createdBody = created.json();
    expect(Object.keys(createdBody).sort()).toEqual(['account', 'temporaryPassword']);
    expect(createdBody.temporaryPassword).toBe(TEMPORARY_PASSWORD);
    expect(Object.keys(createdBody.account).sort()).toEqual(
      [
        'id',
        'username',
        'role',
        'status',
        'employeeId',
        'mustChangePassword',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(created.body).not.toContain('passwordHash');
    expect(harness.repository.persistedHashes).toEqual([`argon2id-test:${TEMPORARY_PASSWORD}`]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/accounts/${CREATED_ID}`,
      headers: { cookie: adminCookie },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: { cookie: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(detail.body).not.toContain(TEMPORARY_PASSWORD);
    expect(detail.body).not.toContain('passwordHash');
    expect(listed.body).not.toContain(TEMPORARY_PASSWORD);
    expect(listed.body).not.toContain('passwordHash');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${CREATED_ID}`,
      headers,
      payload: { username: 'renamed-user', status: AccountStatus.SUSPENDED },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.headers['cache-control']).toBe('no-store');
    expect(patched.json()).toMatchObject({
      id: CREATED_ID,
      username: 'renamed-user',
      status: AccountStatus.SUSPENDED,
    });
    expect(patched.body).not.toContain(TEMPORARY_PASSWORD);
    expect(patched.body).not.toContain('passwordHash');

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${CREATED_ID}/deactivate`,
      headers,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.headers['cache-control']).toBe('no-store');
    expect(deactivated.json()).toMatchObject({ id: CREATED_ID, status: AccountStatus.INACTIVE });
    expect(deactivated.body).not.toContain(TEMPORARY_PASSWORD);
    expect(deactivated.body).not.toContain('passwordHash');
    expect(harness.repository.rows.has(CREATED_ID)).toBe(true);
  });

  it('applies the configured sensitive write rate limit and keeps the rejection no-store', async () => {
    const harness = createHarness({ accountRateLimit: 1 });
    const app = await harness.appPromise;
    apps.push(app);
    const adminCookie = await login(app, 'admin');
    const request = (username: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers: { origin: ORIGIN, cookie: adminCookie },
        payload: { username, role: UserRole.EMPLOYEE },
      });

    const allowed = await request('first-user');
    const limited = await request('second-user');

    expect(allowed.statusCode).toBe(201);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(harness.repository.rows.has(CREATED_ID)).toBe(true);
    expect(
      [...harness.repository.rows.values()].some((account) => account.username === 'second-user'),
    ).toBe(false);
  });
});
