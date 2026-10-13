import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { buildApp } from '../../src/app.js';
import { AccountStatus, DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog, Prisma } from '../../src/generated/prisma/client.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
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
import {
  ConsentService,
  createConsentPolicyProvider,
  type ConsentCreateInput,
  type ConsentHistoryItem,
  type ConsentHistoryQuery,
  type ConsentRecord,
  type ConsentRepository,
} from '../../src/modules/consent/index.js';

const ADMIN_ID = 'ac8fe71b-4807-421e-9738-0ae6fc9b5d42';
const EMPLOYEE_ID = 'b48caa23-ae55-4413-a2b3-6a53788466df';
const EMPLOYEE_PROFILE_ID = '77a5fe3a-4a02-46e8-b9ca-bc143c533117';
const employeeDevice = {
  deviceToken: 'QmFzZTY0VXJsRGV2aWNlVG9rZW5Gb3JVbml0VGVzdHM',
  deviceName: 'Test work phone',
};
const ORIGIN = 'http://localhost:5173';
const now = new Date('2026-10-11T02:00:00.000Z');

function makeAccount(
  id: string,
  username: string,
  role: UserRole,
  employeeId: string | null,
): AuthAccount {
  return {
    id,
    username,
    employeeNik: role === UserRole.EMPLOYEE ? 'NIK-100' : null,
    passwordHash: `hash:${username}-password`,
    role,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    employeeId,
  };
}

class InjectAuthRepository implements AuthRepository {
  readonly accounts = new Map<string, AuthAccount>();
  readonly sessions = new Map<string, AuthSession>();

  constructor(private readonly deviceBindings: FakeDeviceBindingRepository) {
    const admin = makeAccount(ADMIN_ID, 'admin', UserRole.ADMIN, null);
    const employee = makeAccount(EMPLOYEE_ID, 'employee', UserRole.EMPLOYEE, EMPLOYEE_PROFILE_ID);
    this.accounts.set(admin.id, admin);
    this.accounts.set(employee.id, employee);
  }

  async findAccountsByIdentifier(identifier: string): Promise<readonly AuthAccount[]> {
    return [...this.accounts.values()].filter(
      (account) => account.username === identifier || account.employeeNik === identifier,
    );
  }

  async recordFailedLogin(
    accountId: string,
    currentTime: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<LoginAttemptUpdate> {
    const account = this.accounts.get(accountId);
    if (!account) return { failedLoginAttempts: 0, lockedUntil: null };
    const count =
      (account.lockedUntil && account.lockedUntil <= currentTime
        ? 0
        : account.failedLoginAttempts) + 1;
    const lockedUntil =
      count >= failureLimit ? new Date(currentTime.getTime() + lockDurationMs) : null;
    this.accounts.set(accountId, { ...account, failedLoginAttempts: count, lockedUntil });
    return { failedLoginAttempts: count, lockedUntil };
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
    const created = this.makeSession(
      input.accountId,
      input.tokenHash,
      input.now,
      input.deviceBindingId,
    );
    return { account: updated, session: created, deviceBindingStatus };
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

  async touchSession(sessionId: string, currentTime: Date): Promise<boolean> {
    const session = [...this.sessions.values()].find((item) => item.id === sessionId);
    if (!session || session.revokedAt) return false;
    this.sessions.set(session.id, { ...session, lastSeenAt: currentTime, updatedAt: currentTime });
    return true;
  }

  async revokeSession(sessionId: string, currentTime: Date): Promise<void> {
    const session = [...this.sessions.values()].find((item) => item.id === sessionId);
    if (session && !session.revokedAt) {
      this.sessions.set(session.id, { ...session, revokedAt: currentTime, updatedAt: currentTime });
    }
  }

  async revokeAccountSessions(accountId: string, currentTime: Date): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userAccountId === accountId && !session.revokedAt) {
        this.sessions.set(id, { ...session, revokedAt: currentTime, updatedAt: currentTime });
      }
    }
  }

  async findAccountById(accountId: string): Promise<AuthAccount | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async resetPassword(
    accountId: string,
    newHash: string,
    currentTime: Date,
  ): Promise<PasswordResetMutation | null> {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    const updated = {
      ...account,
      passwordHash: newHash,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    this.accounts.set(accountId, updated);
    await this.revokeAccountSessions(accountId, currentTime);
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
    this.accounts.set(input.accountId, updated);
    await this.revokeAccountSessions(input.accountId, input.now);
    return {
      account: updated,
      session: this.makeSession(input.accountId, input.tokenHash, input.now, input.deviceBindingId),
      deviceBindingStatus,
    };
  }

  private makeSession(
    accountId: string,
    tokenHash: string,
    currentTime: Date,
    deviceBindingId: string | null,
  ): AuthSession {
    const session: AuthSession = {
      id: `session-${this.sessions.size + 1}`,
      userAccountId: accountId,
      deviceBindingId,
      tokenHash,
      lastSeenAt: currentTime,
      revokedAt: null,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    this.sessions.set(session.id, session);
    return session;
  }
}

class InjectConsentRepository implements ConsentRepository {
  readonly records: ConsentRecord[] = [];
  readonly historyQueries: ConsentHistoryQuery[] = [];
  private nextId = 0;

  async findLatestForAccount(userAccountId: string): Promise<ConsentRecord | null> {
    return (
      [...this.records]
        .filter((record) => record.userAccountId === userAccountId)
        .sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime())[0] ?? null
    );
  }

  async acceptOnce(input: ConsentCreateInput) {
    const latest = await this.findLatestForAccount(input.userAccountId);
    if (
      latest &&
      latest.withdrawnAt === null &&
      latest.policyVersion === input.policyVersion &&
      latest.consentTextHash === input.consentTextHash &&
      JSON.stringify(latest.purposes) === JSON.stringify(input.purposes)
    ) {
      return { record: latest, created: false } as const;
    }
    const record: ConsentRecord = {
      id: `consent-${++this.nextId}`,
      ...input,
      purposes: JSON.parse(JSON.stringify(input.purposes)) as Prisma.JsonValue,
      withdrawnAt: null,
    };
    this.records.push(record);
    return { record, created: true } as const;
  }

  async findHistory(query: ConsentHistoryQuery): Promise<readonly ConsentHistoryItem[]> {
    this.historyQueries.push(query);
    const rows = this.records.filter((record) =>
      query.scope.kind === 'owner'
        ? record.userAccountId === query.scope.userAccountId
        : !query.scope.userAccountId || record.userAccountId === query.scope.userAccountId,
    );
    return rows
      .slice(query.skip, query.skip + query.take)
      .map(({ id, policyVersion, purposes, acceptedAt, withdrawnAt }) => ({
        id,
        policyVersion,
        purposes,
        acceptedAt,
        withdrawnAt,
      }));
  }
}

function createHarness(
  options: {
    secureCookies?: boolean;
    loginMax?: number;
    cookieSecret?: string | null;
    consentRequired?: boolean;
    employeeMustChangePassword?: boolean;
    withConsents?: boolean;
    consentPolicyConfigured?: boolean;
    readiness?: () => Promise<void>;
  } = {},
) {
  const bindingRepository = new FakeDeviceBindingRepository();
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    record: async (event: RecordAuditEventInput) => {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  const repository = new InjectAuthRepository(bindingRepository);
  if (options.employeeMustChangePassword) {
    const employee = repository.accounts.get(EMPLOYEE_ID);
    if (employee) repository.accounts.set(EMPLOYEE_ID, { ...employee, mustChangePassword: true });
  }
  const consentRepository = new InjectConsentRepository();
  const consentService = options.withConsents
    ? new ConsentService({
        repository: consentRepository,
        policyProvider: createConsentPolicyProvider(
          options.consentPolicyConfigured === false
            ? {}
            : { version: 'v1', text: 'Company-approved test privacy notice.' },
        ),
        audit,
        now: () => new Date(now),
      })
    : undefined;
  let tokenNumber = 0;
  const deviceBindings = createFakeDeviceBindingService(
    bindingRepository,
    audit,
    () => new Date(now),
  );
  const service = new AuthService({
    repository,
    passwordHasher: {
      hash: async (password) => `hash:${password}`,
      verify: async (hash, password) => hash === `hash:${password}`,
    },
    audit,
    dummyPasswordHash: 'hash:dummy',
    consentStatus: consentService ?? {
      isConsentRequired: async () => options.consentRequired ?? false,
    },
    deviceBindings,
    now: () => new Date(now),
    createToken: () => `opaque-test-token-${++tokenNumber}-` + 'x'.repeat(24),
  });
  const appPromise = buildApp({
    logger: false,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    auth: {
      service,
      ...(options.cookieSecret === null
        ? {}
        : {
            cookieSecret: options.cookieSecret ?? 'test-cookie-signing-secret-that-is-long-enough',
          }),
      secureCookies: options.secureCookies ?? false,
      allowedOrigin: ORIGIN,
      loginRateLimit: { max: options.loginMax ?? 100, timeWindow: '1 minute' },
      sensitiveRateLimit: { max: 100, timeWindow: '1 minute' },
    },
    ...(consentService ? { consents: { service: consentService } } : {}),
  });
  return {
    appPromise,
    repository,
    bindingRepository,
    consentRepository,
    consentService,
    auditEvents,
  };
}

function setEmployeeDeviceStatus(
  harness: ReturnType<typeof createHarness>,
  status: DeviceBindingStatus,
): void {
  const session = [...harness.repository.sessions.values()].find(
    (item) => item.userAccountId === EMPLOYEE_ID && item.deviceBindingId !== null,
  );
  if (!session?.deviceBindingId) throw new Error('Expected an employee session binding.');
  harness.bindingRepository.setStatus(session.deviceBindingId, status);
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const first = (Array.isArray(header) ? header[0] : header) as string | undefined;
  if (!first) throw new Error('Expected session cookie.');
  return first.split(';', 1)[0]!;
}

const originHeaders = { origin: ORIGIN };

describe('authentication routes', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('serves readiness without a session when authentication is configured', async () => {
    const readiness = vi.fn(async () => undefined);
    const harness = createHarness({ readiness });
    const app = await harness.appPromise;
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(readiness).toHaveBeenCalledOnce();
  });

  it('sets strict HttpOnly cookie flags, hides credentials, serves /me, and logs out', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: ' employee ', password: 'employee-password', ...employeeDevice },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { id: EMPLOYEE_ID, role: UserRole.EMPLOYEE } });
    expect(login.body).not.toContain('employee-password');
    expect(login.body).not.toContain('opaque-test-token');
    const setCookie = login.headers['set-cookie'] as string;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    const cookie = sessionCookie(login);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: login.json().user,
      consentRequired: false,
    });
    expect(me.headers['set-cookie']).toContain('Max-Age=604800');
    expect(me.headers['cache-control']).toBe('no-store');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...originHeaders, cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('sets Secure in secure deployments and rejects cross-origin state changes', async () => {
    const harness = createHarness({ secureCookies: true });
    const app = await harness.appPromise;
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { identifier: 'admin', password: 'admin-password' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.body).not.toContain('admin-password');

    const validLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'admin', password: 'admin-password' },
    });
    expect(validLogin.statusCode).toBe(200);
    expect(validLogin.headers['set-cookie']).toContain('Secure');
    expect(validLogin.json().user.deviceBindingStatus).toBeNull();
    expect(harness.repository.sessions.values().next().value?.deviceBindingId).toBeNull();
    expect(harness.bindingRepository.rows.size).toBe(0);
  });

  it('requires employee device data and reports safe live binding status through /me', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    app.get('/api/v1/protected-probe', async () => ({ ok: true }));

    const missingDevice = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password' },
    });
    expect(missingDevice.statusCode).toBe(400);
    expect(missingDevice.json()).toMatchObject({ code: 'DEVICE_INFO_REQUIRED' });
    expect(harness.repository.sessions.size).toBe(0);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    const cookie = sessionCookie(login);
    const currentSession = [...harness.repository.sessions.values()][0];
    if (!currentSession?.deviceBindingId) throw new Error('Expected a bound login session.');
    const binding = harness.bindingRepository.findById(currentSession.deviceBindingId);
    if (!binding) throw new Error('Expected the binding to exist.');
    const deviceTokenHash = createHash('sha256')
      .update(employeeDevice.deviceToken, 'ascii')
      .digest('hex');
    expect(JSON.stringify(login.json())).not.toContain(employeeDevice.deviceToken);
    expect(JSON.stringify(login.json())).not.toContain(deviceTokenHash);
    expect(currentSession).not.toHaveProperty('deviceIdHash');
    expect(currentSession).not.toHaveProperty('deviceToken');
    expect(JSON.stringify(currentSession)).not.toContain(employeeDevice.deviceToken);
    expect(JSON.stringify(currentSession)).not.toContain(deviceTokenHash);

    const pendingMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(pendingMe.statusCode).toBe(200);
    expect(pendingMe.json().user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    expect(pendingMe.body).not.toContain(employeeDevice.deviceToken);
    expect(pendingMe.body).not.toContain(deviceTokenHash);
    const pendingAccess = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie },
    });
    expect(pendingAccess.statusCode).toBe(403);
    expect(pendingAccess.json()).toMatchObject({ code: 'DEVICE_BINDING_PENDING' });

    harness.bindingRepository.setStatus(binding.id, DeviceBindingStatus.APPROVED);
    const approvedMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(approvedMe.json().user.deviceBindingStatus).toBe(DeviceBindingStatus.APPROVED);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/protected-probe',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    harness.bindingRepository.setStatus(binding.id, DeviceBindingStatus.REVOKED);
    const revokedAccess = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie },
    });
    expect(revokedAccess.statusCode).toBe(403);
    expect(revokedAccess.json()).toMatchObject({ code: 'DEVICE_BINDING_REVOKED' });
    const revokedMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(revokedMe.statusCode).toBe(200);
    expect(revokedMe.json().user.deviceBindingStatus).toBe(DeviceBindingStatus.REVOKED);
  });

  it('rotates password/session and revokes old cookie; forced password change is reported', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const oldCookie = sessionCookie(login);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...originHeaders, cookie: oldCookie },
      payload: { currentPassword: 'employee-password', newPassword: 'next-password' },
    });
    expect(changed.statusCode).toBe(200);
    const newCookie = sessionCookie(changed);
    expect(newCookie).not.toBe(oldCookie);
    expect(changed.body).not.toContain('next-password');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: oldCookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: newCookie } }))
        .statusCode,
    ).toBe(200);
    expect(JSON.stringify(harness.auditEvents)).not.toContain('next-password');
    expect(
      [...harness.repository.sessions.values()].every((item) => item.tokenHash.length === 64),
    ).toBe(true);
  });

  it('restricts reset to an authenticated Admin and marks the target for a first-login change', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const employeeLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/admin/accounts/${EMPLOYEE_ID}/reset-password`,
      headers: { ...originHeaders, cookie: sessionCookie(employeeLogin) },
      payload: { temporaryPassword: 'temporary-password' },
    });
    expect(denied.statusCode).toBe(403);

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'admin', password: 'admin-password' },
    });
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/admin/accounts/${EMPLOYEE_ID}/reset-password`,
      headers: { ...originHeaders, cookie: sessionCookie(adminLogin) },
      payload: { temporaryPassword: 'temporary-password' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ accountId: EMPLOYEE_ID, mustChangePassword: true });
    expect(reset.headers['set-cookie']).toContain('Max-Age=1800');
    expect(reset.body).not.toContain('temporary-password');
    expect(harness.repository.accounts.get(EMPLOYEE_ID)?.mustChangePassword).toBe(true);
    expect(JSON.stringify(harness.auditEvents)).not.toContain('temporary-password');
  });

  it('rate-limits login attempts', async () => {
    const harness = createHarness({ loginMax: 2 });
    const app = await harness.appPromise;
    apps.push(app);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: originHeaders,
        payload: { identifier: 'missing', password: 'wrong' },
      });
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'admin', password: 'admin-password' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).not.toContain('admin-password');
  });

  it('rejects missing CSRF Origin and never accepts actor role from request body', async () => {
    const harness = createHarness();
    const app = await harness.appPromise;
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: sessionCookie(login) },
      payload: { currentPassword: 'employee-password', newPassword: 'new-password', role: 'ADMIN' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('new-password');
  });

  it('fails fast when Secure cookies are enabled without a signing secret', async () => {
    const harness = createHarness({ secureCookies: true, cookieSecret: null });
    await expect(harness.appPromise).rejects.toThrow(/SESSION_SECRET/);
  });

  it('keeps onboarding routes available and gates regular features by consent before password change', async () => {
    const needsBoth = createHarness({ consentRequired: true, employeeMustChangePassword: true });
    const app = await needsBoth.appPromise;
    apps.push(app);
    app.get('/api/v1/protected-probe', async () => ({ ok: true }));
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      consentRequired: true,
      user: { mustChangePassword: true },
    });
    const cookie = sessionCookie(login);
    const gatedByConsent = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie },
    });
    expect(gatedByConsent.statusCode).toBe(403);
    expect(gatedByConsent.json()).toMatchObject({ code: 'CONSENT_REQUIRED' });

    const passwordChange = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...originHeaders, cookie },
      payload: { currentPassword: 'employee-password', newPassword: 'next-password' },
    });
    expect(passwordChange.statusCode).toBe(200);
    expect(passwordChange.json()).toMatchObject({
      consentRequired: true,
      user: { mustChangePassword: false },
    });

    const needsPasswordOnly = createHarness({
      consentRequired: false,
      employeeMustChangePassword: true,
    });
    const passwordApp = await needsPasswordOnly.appPromise;
    apps.push(passwordApp);
    passwordApp.get('/api/v1/protected-probe', async () => ({ ok: true }));
    const passwordLogin = await passwordApp.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const passwordCookie = sessionCookie(passwordLogin);
    const gatedByPassword = await passwordApp.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie: passwordCookie },
    });
    expect(gatedByPassword.statusCode).toBe(403);
    expect(gatedByPassword.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    const passwordOnlyChange = await passwordApp.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...originHeaders, cookie: passwordCookie },
      payload: { currentPassword: 'employee-password', newPassword: 'next-password' },
    });
    const freshCookie = sessionCookie(passwordOnlyChange);
    setEmployeeDeviceStatus(needsPasswordOnly, DeviceBindingStatus.APPROVED);
    expect(
      (
        await passwordApp.inject({
          method: 'GET',
          url: '/api/v1/protected-probe',
          headers: { cookie: freshCookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('accepts only the exact client contract and persists session/server-derived consent facts', async () => {
    const harness = createHarness({ withConsents: true, employeeMustChangePassword: true });
    const app = await harness.appPromise;
    apps.push(app);
    app.get('/api/v1/protected-probe', async () => ({ ok: true }));
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const cookie = sessionCookie(login);
    expect(login.json()).toMatchObject({ consentRequired: true });
    const consentGate = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie },
    });
    expect(consentGate.statusCode).toBe(403);
    expect(consentGate.json()).toMatchObject({ code: 'CONSENT_REQUIRED' });

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/consents/current',
      headers: { cookie },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      consentRequired: true,
      policy: { version: 'v1', text: 'Company-approved test privacy notice.' },
    });

    const tampered = await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie },
      payload: {
        policyVersion: 'v1',
        accepted: true,
        userAccountId: ADMIN_ID,
        employeeId: ADMIN_ID,
        acceptedAt: '2000-01-01T00:00:00.000Z',
        clientIp: '203.0.113.44',
        text: 'client policy',
        purposes: [],
        consentTextHash: 'forged',
      },
    });
    expect(tampered.statusCode).toBe(400);
    expect(harness.consentRepository.records).toHaveLength(0);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie },
      payload: { policyVersion: 'v0', accepted: true },
    });
    expect(stale.statusCode).toBe(409);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie, 'x-forwarded-for': '198.51.100.42' },
      payload: { policyVersion: 'v1', accepted: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ policyVersion: 'v1', acceptedAt: now.toISOString() });
    expect(accepted.json()).not.toHaveProperty('userAccountId');
    expect(accepted.json()).not.toHaveProperty('clientIp');
    expect(accepted.json()).not.toHaveProperty('consentTextHash');
    const [record] = harness.consentRepository.records;
    expect(record).toMatchObject({
      userAccountId: EMPLOYEE_ID,
      employeeId: EMPLOYEE_PROFILE_ID,
      policyVersion: 'v1',
      acceptedAt: now,
    });
    expect(record?.clientIp).toBe('127.0.0.1');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie },
      payload: { policyVersion: 'v1', accepted: true },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ alreadyAccepted: true });
    expect(harness.consentRepository.records).toHaveLength(1);
    expect(harness.auditEvents).toContainEqual(
      expect.objectContaining({ action: 'consent.accepted', entityType: 'ConsentRecord' }),
    );
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ consentRequired: false, user: { consentRequired: false } });
    const passwordGate = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie },
    });
    expect(passwordGate.statusCode).toBe(403);
    expect(passwordGate.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    const changedPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...originHeaders, cookie },
      payload: { currentPassword: 'employee-password', newPassword: 'next-password' },
    });
    expect(changedPassword.statusCode).toBe(200);
    const renewedCookie = sessionCookie(changedPassword);
    setEmployeeDeviceStatus(harness, DeviceBindingStatus.APPROVED);
    const regularFeature = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { cookie: renewedCookie },
    });
    expect(regularFeature.statusCode).toBe(200);
    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/consents/history',
      headers: { cookie: renewedCookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain('127.0.0.1');
    expect(history.body).not.toContain(harness.consentRepository.records[0]?.consentTextHash);
  });

  it('fails current/accept with 503 when policy is missing but leaves health, me, and onboarding reachable', async () => {
    const harness = createHarness({ withConsents: true, consentPolicyConfigured: false });
    const app = await harness.appPromise;
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const cookie = sessionCookie(login);
    expect(login.json()).toMatchObject({ consentRequired: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);
    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/consents/current',
      headers: { cookie },
    });
    expect(current.statusCode).toBe(503);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie },
      payload: { policyVersion: 'v1', accepted: true },
    });
    expect(accept.statusCode).toBe(503);
    expect(harness.consentRepository.records).toHaveLength(0);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...originHeaders, cookie },
    });
    expect(logout.statusCode).toBe(204);
  });

  it('limits consent history to owner or Admin-filtered account scope', async () => {
    const harness = createHarness({ withConsents: true });
    const app = await harness.appPromise;
    apps.push(app);
    const employeeLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'employee', password: 'employee-password', ...employeeDevice },
    });
    const employeeCookie = sessionCookie(employeeLogin);
    await app.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: { ...originHeaders, cookie: employeeCookie },
      payload: { policyVersion: 'v1', accepted: true },
    });
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/consents/history?accountId=${ADMIN_ID}`,
      headers: { cookie: employeeCookie },
    });
    expect(denied.statusCode).toBe(403);
    const ownerHistory = await app.inject({
      method: 'GET',
      url: '/api/v1/consents/history',
      headers: { cookie: employeeCookie },
    });
    expect(ownerHistory.statusCode).toBe(200);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: originHeaders,
      payload: { identifier: 'admin', password: 'admin-password' },
    });
    const adminHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/consents/history?accountId=${EMPLOYEE_ID}`,
      headers: { cookie: sessionCookie(adminLogin) },
    });
    expect(adminHistory.statusCode).toBe(200);
    expect(adminHistory.json().items).toHaveLength(1);
    expect(harness.consentRepository.historyQueries.at(-1)?.scope).toEqual({
      kind: 'admin',
      userAccountId: EMPLOYEE_ID,
    });
    expect(harness.consentRepository.historyQueries[0]?.scope).toEqual({
      kind: 'owner',
      userAccountId: EMPLOYEE_ID,
    });
  });
});
