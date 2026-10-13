import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { AccountStatus, DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog } from '../../src/generated/prisma/client.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import type {
  AuthAccount,
  AuthRepository,
  AuthSession,
  AuthSessionWithAccount,
  CompleteLoginInput,
  CompleteLoginResult,
  LoginAttemptUpdate,
  RotatePasswordInput,
} from '../../src/modules/auth/contracts.js';
import { AuthService, hashSessionToken } from '../../src/modules/auth/service.js';
import {
  createFakeDeviceBindingService,
  FakeDeviceBindingRepository,
} from '../helpers/fake-device-binding.js';

const ACCOUNT_ID = '2d3d5e82-561a-4a70-9af5-2c088516379a';
const OTHER_ACCOUNT_ID = '9e5bca7d-bef8-4e76-8f99-b5c2259470c9';
const DEVICE_TOKEN = 'QmFzZTY0VXJsRGV2aWNlVG9rZW5Gb3JVbml0VGVzdHM';
const DEVICE_NAME = 'Test work phone';
const INITIAL_TIME = new Date('2026-10-11T02:00:00.000Z');

function account(overrides: Partial<AuthAccount> = {}): AuthAccount {
  return {
    id: ACCOUNT_ID,
    username: 'KaryawanA',
    employeeNik: 'NIK-001',
    passwordHash: 'hash:correct horse',
    role: UserRole.EMPLOYEE,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    employeeId: 'b384db3b-48e9-49c7-bcac-1998a58b99d2',
    ...overrides,
  };
}

function session(
  userAccountId: string,
  tokenHash: string,
  now = INITIAL_TIME,
  overrides: Partial<AuthSession> = {},
): AuthSession {
  return {
    id: `session-${tokenHash.slice(0, 8)}`,
    userAccountId,
    deviceBindingId: null,
    tokenHash,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeAuthRepository implements AuthRepository {
  readonly accounts = new Map<string, AuthAccount>();
  readonly sessions = new Map<string, AuthSession>();

  constructor(
    initialAccounts: readonly AuthAccount[],
    private readonly deviceBindings: FakeDeviceBindingRepository,
  ) {
    for (const item of initialAccounts) this.accounts.set(item.id, item);
  }

  async findAccountsByIdentifier(identifier: string): Promise<readonly AuthAccount[]> {
    return [...this.accounts.values()].filter(
      (item) => item.username === identifier || item.employeeNik === identifier,
    );
  }

  async recordFailedLogin(
    accountId: string,
    now: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<LoginAttemptUpdate> {
    const current = this.accounts.get(accountId);
    if (!current) return { failedLoginAttempts: 0, lockedUntil: null };
    if (current.lockedUntil && current.lockedUntil > now) {
      return { failedLoginAttempts: current.failedLoginAttempts, lockedUntil: current.lockedUntil };
    }
    const previousAttempts = current.lockedUntil ? 0 : current.failedLoginAttempts;
    const failedLoginAttempts = previousAttempts + 1;
    const lockedUntil =
      failedLoginAttempts >= failureLimit ? new Date(now.getTime() + lockDurationMs) : null;
    this.accounts.set(accountId, { ...current, failedLoginAttempts, lockedUntil });
    return { failedLoginAttempts, lockedUntil };
  }

  async completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult | null> {
    const current = this.accounts.get(input.accountId);
    if (
      !current ||
      current.status !== AccountStatus.ACTIVE ||
      current.passwordHash !== input.expectedPasswordHash
    ) {
      return null;
    }
    let deviceBindingStatus: DeviceBindingStatus | null = null;
    if (current.role !== UserRole.ADMIN) {
      const binding = input.deviceBindingId
        ? this.deviceBindings.findById(input.deviceBindingId)
        : null;
      if (
        !current.employeeId ||
        !binding ||
        binding.employeeId !== current.employeeId ||
        binding.status === DeviceBindingStatus.REVOKED
      ) {
        return null;
      }
      deviceBindingStatus = binding.status;
    } else if (input.deviceBindingId !== null) {
      return null;
    }
    const updated = {
      ...current,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: input.now,
    };
    this.accounts.set(current.id, updated);
    const created = session(current.id, input.tokenHash, input.now, {
      deviceBindingId: input.deviceBindingId,
    });
    this.sessions.set(created.id, created);
    return { account: updated, session: created, deviceBindingStatus };
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionWithAccount | null> {
    const found = [...this.sessions.values()].find((item) => item.tokenHash === tokenHash);
    const foundAccount = found ? this.accounts.get(found.userAccountId) : undefined;
    const binding = found?.deviceBindingId
      ? this.deviceBindings.findById(found.deviceBindingId)
      : null;
    return found && foundAccount
      ? { session: found, account: foundAccount, deviceBindingStatus: binding?.status ?? null }
      : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<boolean> {
    const current = [...this.sessions.values()].find((item) => item.id === sessionId);
    if (!current || current.revokedAt) return false;
    this.sessions.set(current.id, { ...current, lastSeenAt: now, updatedAt: now });
    return true;
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    const current = [...this.sessions.values()].find((item) => item.id === sessionId);
    if (current && !current.revokedAt) {
      this.sessions.set(current.id, { ...current, revokedAt: now, updatedAt: now });
    }
  }

  async revokeAccountSessions(accountId: string, now: Date): Promise<void> {
    for (const [id, current] of this.sessions) {
      if (current.userAccountId === accountId && !current.revokedAt) {
        this.sessions.set(id, { ...current, revokedAt: now, updatedAt: now });
      }
    }
  }

  async findAccountById(accountId: string): Promise<AuthAccount | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async resetPassword(
    accountId: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<{ before: AuthAccount; after: AuthAccount } | null> {
    const current = this.accounts.get(accountId);
    if (!current) return null;
    const updated = {
      ...current,
      passwordHash: newPasswordHash,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    this.accounts.set(accountId, updated);
    await this.revokeAccountSessions(accountId, now);
    return { before: current, after: updated };
  }

  async rotatePassword(input: RotatePasswordInput): Promise<CompleteLoginResult | null> {
    const current = this.accounts.get(input.accountId);
    if (!current || current.passwordHash !== input.expectedPasswordHash) return null;
    let deviceBindingStatus: DeviceBindingStatus | null = null;
    if (current.role === UserRole.ADMIN) {
      if (input.deviceBindingId !== null) return null;
    } else {
      if (!current.employeeId || input.deviceBindingId === null) return null;
      const binding = this.deviceBindings.findById(input.deviceBindingId);
      if (
        !binding ||
        binding.employeeId !== current.employeeId ||
        binding.status === DeviceBindingStatus.REVOKED
      ) {
        return null;
      }
      deviceBindingStatus = binding.status;
    }
    const updated = {
      ...current,
      passwordHash: input.newPasswordHash,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    this.accounts.set(input.accountId, updated);
    await this.revokeAccountSessions(input.accountId, input.now);
    const created = session(input.accountId, input.tokenHash, input.now, {
      deviceBindingId: input.deviceBindingId,
    });
    this.sessions.set(created.id, created);
    return { account: updated, session: created, deviceBindingStatus };
  }
}

function setup(
  initial: readonly AuthAccount[] = [account()],
  options: { withDeviceBindings?: boolean } = {},
) {
  const bindingRepository = new FakeDeviceBindingRepository();
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    record: async (event: RecordAuditEventInput) => {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  let now = new Date(INITIAL_TIME);
  const deviceBindings = createFakeDeviceBindingService(
    bindingRepository,
    audit,
    () => new Date(now),
  );
  const repository = new FakeAuthRepository(initial, bindingRepository);
  let nextToken = 'A'.repeat(43);
  const service = new AuthService({
    repository,
    passwordHasher: {
      hash: async (password) => `hash:${password}`,
      verify: async (passwordHash, password) => passwordHash === `hash:${password}`,
    },
    audit,
    dummyPasswordHash: 'hash:dummy-password-for-unknown-identifiers',
    consentStatus: { isConsentRequired: async () => false },
    ...(options.withDeviceBindings === false ? {} : { deviceBindings }),
    now: () => new Date(now),
    createToken: () => nextToken,
  });
  return {
    service,
    repository,
    bindingRepository,
    auditEvents,
    setNow(value: Date) {
      now = new Date(value);
    },
    setToken(value: string) {
      nextToken = value;
    },
  };
}

function loginEmployee(service: AuthService, identifier: string, password: string) {
  return service.login({
    identifier,
    password,
    deviceToken: DEVICE_TOKEN,
    deviceName: DEVICE_NAME,
  });
}

describe('AuthService', () => {
  it('logs in by exact-case username or NIK after trimming, resets failures, and persists only SHA-256 token hash', async () => {
    const harness = setup([account({ failedLoginAttempts: 2 })]);
    const result = await loginEmployee(harness.service, '  NIK-001 ', 'correct horse');
    const persisted = [...harness.repository.sessions.values()][0];
    if (!persisted) throw new Error('Successful login must persist a session.');

    expect(result.user).toMatchObject({ id: ACCOUNT_ID, username: 'KaryawanA' });
    expect(result.user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    expect(result.cookieToken).toBe('A'.repeat(43));
    expect(persisted.tokenHash).toBe(hashSessionToken(result.cookieToken));
    expect(persisted.tokenHash).not.toContain(result.cookieToken);
    const binding = harness.bindingRepository.findById(persisted.deviceBindingId!);
    if (!binding) throw new Error('Successful employee login must bind a device.');
    const expectedDeviceHash = createHash('sha256').update(DEVICE_TOKEN, 'ascii').digest('hex');
    expect(binding.deviceIdHash).toBe(expectedDeviceHash);
    expect(persisted).not.toHaveProperty('deviceToken');
    expect(persisted).not.toHaveProperty('deviceIdHash');
    expect(JSON.stringify(result.user)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(result.user)).not.toContain(expectedDeviceHash);
    expect(JSON.stringify(persisted)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(persisted)).not.toContain(expectedDeviceHash);
    expect(harness.repository.accounts.get(ACCOUNT_ID)).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: INITIAL_TIME,
    });
    expect(harness.auditEvents.map(({ action }) => action)).toEqual([
      'device_binding.enrolled',
      'auth.login.success',
    ]);
    expect(harness.auditEvents[1]).toMatchObject({
      actor: expect.objectContaining({ userAccountId: ACCOUNT_ID, role: UserRole.EMPLOYEE }),
      action: 'auth.login.success',
      entityType: 'UserAccount',
      entityId: ACCOUNT_ID,
      after: { outcome: 'success', role: UserRole.EMPLOYEE },
    });
    await expect(
      loginEmployee(harness.service, 'karyawana', 'correct horse'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
  });

  it('returns the same generic failure for unknown identifiers and wrong passwords', async () => {
    const harness = setup();
    const wrongPassword = await harness.service
      .login({ identifier: 'KaryawanA', password: 'wrong' })
      .catch((error: unknown) => error);
    const unknownIdentifier = await harness.service
      .login({ identifier: 'not-an-account', password: 'wrong' })
      .catch((error: unknown) => error);

    expect(wrongPassword).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      publicMessage: expect.any(String),
    });
    expect(unknownIdentifier).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      publicMessage: (wrongPassword as { publicMessage: string }).publicMessage,
    });
    expect(
      harness.auditEvents.map(({ action, entityId, reason }) => ({ action, entityId, reason })),
    ).toEqual([
      { action: 'auth.login.failure', entityId: ACCOUNT_ID, reason: 'invalid_credentials' },
      { action: 'auth.login.failure', entityId: null, reason: 'invalid_credentials' },
    ]);
    expect(JSON.stringify(harness.auditEvents)).not.toContain('wrong');
    expect(JSON.stringify(harness.auditEvents)).not.toContain('passwordHash');
  });

  it('lets Admin log in without device data and keeps the session unbound', async () => {
    const admin = account({ role: UserRole.ADMIN, employeeId: null });
    const harness = setup([admin]);
    const login = await harness.service.login({
      identifier: admin.username,
      password: 'correct horse',
    });
    const persisted = [...harness.repository.sessions.values()][0];

    expect(login.user.deviceBindingStatus).toBeNull();
    expect(persisted?.deviceBindingId).toBeNull();
    expect(harness.bindingRepository.rows.size).toBe(0);
  });

  it('fails closed with safe errors for a missing employee profile, missing device data, or unavailable enrollment', async () => {
    const noProfile = setup([account({ employeeId: null })]);
    await expect(
      noProfile.service.login({
        identifier: 'KaryawanA',
        password: 'correct horse',
        ...{ deviceToken: DEVICE_TOKEN, deviceName: DEVICE_NAME },
      }),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_PROFILE_REQUIRED', statusCode: 403 });
    expect(noProfile.repository.sessions.size).toBe(0);
    expect(noProfile.bindingRepository.rows.size).toBe(0);

    const missingDevice = setup();
    await expect(
      missingDevice.service.login({ identifier: 'KaryawanA', password: 'correct horse' }),
    ).rejects.toMatchObject({ code: 'DEVICE_INFO_REQUIRED', statusCode: 400 });
    expect(missingDevice.repository.sessions.size).toBe(0);

    const unavailable = setup([account()], { withDeviceBindings: false });
    await expect(
      unavailable.service.login({
        identifier: 'KaryawanA',
        password: 'correct horse',
        deviceToken: DEVICE_TOKEN,
        deviceName: DEVICE_NAME,
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_ENROLLMENT_UNAVAILABLE', statusCode: 503 });
    expect(unavailable.repository.sessions.size).toBe(0);
  });

  it('refreshes binding status on each request and gates pending or revoked devices until approved', async () => {
    const harness = setup();
    const login = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    const storedSession = [...harness.repository.sessions.values()][0];
    if (!storedSession?.deviceBindingId) throw new Error('Expected a bound session.');

    expect(login.user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    const pendingSession = await harness.service.authenticate(login.cookieToken);
    expect(pendingSession.user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    expect(() => harness.service.requireRegularAccess(pendingSession.principal)).toThrow(
      expect.objectContaining({ code: 'DEVICE_BINDING_PENDING', statusCode: 403 }),
    );

    harness.bindingRepository.setStatus(
      storedSession.deviceBindingId,
      DeviceBindingStatus.APPROVED,
    );
    const approvedSession = await harness.service.authenticate(login.cookieToken);
    expect(approvedSession.user.deviceBindingStatus).toBe(DeviceBindingStatus.APPROVED);
    expect(() => harness.service.requireRegularAccess(approvedSession.principal)).not.toThrow();

    harness.bindingRepository.setStatus(storedSession.deviceBindingId, DeviceBindingStatus.REVOKED);
    const revokedSession = await harness.service.authenticate(login.cookieToken);
    expect(revokedSession.user.deviceBindingStatus).toBe(DeviceBindingStatus.REVOKED);
    expect(() => harness.service.requireRegularAccess(revokedSession.principal)).toThrow(
      expect.objectContaining({ code: 'DEVICE_BINDING_REVOKED', statusCode: 403 }),
    );
  });

  it('locks immediately on the fifth failure for 15 minutes and does not increment while locked', async () => {
    const harness = setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(loginEmployee(harness.service, 'KaryawanA', 'wrong')).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    }
    expect(harness.repository.accounts.get(ACCOUNT_ID)).toMatchObject({
      failedLoginAttempts: 5,
      lockedUntil: new Date(INITIAL_TIME.getTime() + 15 * 60_000),
    });
    await expect(
      loginEmployee(harness.service, 'KaryawanA', 'correct horse'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(harness.repository.accounts.get(ACCOUNT_ID)?.failedLoginAttempts).toBe(5);
  });

  it('allows attempts after lock expiry and successful login resets lockout counters', async () => {
    const lockedUntil = new Date(INITIAL_TIME.getTime() + 15 * 60_000);
    const harness = setup([account({ failedLoginAttempts: 5, lockedUntil })]);
    harness.setNow(lockedUntil);
    const login = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    expect(login.user.id).toBe(ACCOUNT_ID);
    expect(harness.repository.accounts.get(ACCOUNT_ID)).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  });

  it('applies a 30-minute Admin inactivity timeout and a seven-day non-Admin timeout', async () => {
    const admin = account({ role: UserRole.ADMIN, employeeId: null });
    const adminHarness = setup([admin]);
    const adminLogin = await adminHarness.service.login({
      identifier: admin.username,
      password: 'correct horse',
    });
    adminHarness.setNow(new Date(INITIAL_TIME.getTime() + 30 * 60_000));
    await expect(adminHarness.service.authenticate(adminLogin.cookieToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    const employeeHarness = setup();
    const employeeLogin = await loginEmployee(
      employeeHarness.service,
      'KaryawanA',
      'correct horse',
    );
    employeeHarness.setNow(new Date(INITIAL_TIME.getTime() + 7 * 24 * 60 * 60_000 - 1));
    await expect(
      employeeHarness.service.authenticate(employeeLogin.cookieToken),
    ).resolves.toBeTruthy();
  });

  it('slides inactivity on activity and revokes expired sessions', async () => {
    const harness = setup();
    const login = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    harness.setNow(new Date(INITIAL_TIME.getTime() + 6 * 24 * 60 * 60_000));
    const sessionResult = await harness.service.authenticate(login.cookieToken);
    expect(sessionResult.principal.lastSeenAt).toEqual(
      new Date(INITIAL_TIME.getTime() + 6 * 24 * 60 * 60_000),
    );
    harness.setNow(new Date(INITIAL_TIME.getTime() + 13 * 24 * 60 * 60_000 - 1));
    await expect(harness.service.authenticate(login.cookieToken)).resolves.toBeTruthy();
    harness.setNow(new Date(INITIAL_TIME.getTime() + 20 * 24 * 60 * 60_000));
    await expect(harness.service.authenticate(login.cookieToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('logout revokes only the current session', async () => {
    const harness = setup();
    const firstLogin = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    harness.setToken('B'.repeat(43));
    const secondLogin = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    const first = await harness.service.authenticate(firstLogin.cookieToken);
    await harness.service.logout(first.principal);
    await expect(harness.service.authenticate(firstLogin.cookieToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(harness.service.authenticate(secondLogin.cookieToken)).resolves.toBeTruthy();
    expect(harness.auditEvents.map(({ action }) => action)).toEqual([
      'device_binding.enrolled',
      'auth.login.success',
      'auth.login.success',
      'auth.logout',
    ]);
    expect(harness.auditEvents[3]).toMatchObject({
      actor: expect.objectContaining({ userAccountId: ACCOUNT_ID, role: UserRole.EMPLOYEE }),
      action: 'auth.logout',
      entityType: 'UserAccount',
      entityId: ACCOUNT_ID,
    });
  });

  it('changes password, rotates the cookie token, and revokes every previous session', async () => {
    const harness = setup();
    const oldLogin = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    harness.setToken('C'.repeat(43));
    const principal = (await harness.service.authenticate(oldLogin.cookieToken)).principal;
    const result = await harness.service.changePassword(principal, {
      currentPassword: 'correct horse',
      newPassword: 'new password',
    });

    expect(result.cookieToken).toBe('C'.repeat(43));
    expect(result.user.mustChangePassword).toBe(false);
    const previousSession = [...harness.repository.sessions.values()].find(
      (item) => item.tokenHash === hashSessionToken(oldLogin.cookieToken),
    );
    const replacementSession = [...harness.repository.sessions.values()].find(
      (item) => item.tokenHash === hashSessionToken(result.cookieToken),
    );
    expect(previousSession?.deviceBindingId).toBeTruthy();
    expect(replacementSession?.deviceBindingId).toBe(previousSession?.deviceBindingId);
    expect(result.user.deviceBindingStatus).toBe(DeviceBindingStatus.PENDING);
    await expect(harness.service.authenticate(oldLogin.cookieToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(harness.service.authenticate(result.cookieToken)).resolves.toBeTruthy();
    expect(
      [...harness.repository.sessions.values()].every(
        (item) => item.tokenHash !== result.cookieToken,
      ),
    ).toBe(true);
    expect(harness.auditEvents.map(({ action }) => action)).toEqual([
      'device_binding.enrolled',
      'auth.login.success',
      'auth.password.change',
    ]);
    expect(harness.auditEvents[2]).toMatchObject({
      actor: expect.objectContaining({ userAccountId: ACCOUNT_ID, role: UserRole.EMPLOYEE }),
      action: 'auth.password.change',
      entityType: 'UserAccount',
      entityId: ACCOUNT_ID,
      before: { mustChangePassword: false },
      after: { mustChangePassword: false, sessionsRevoked: true },
    });
  });

  it('does not rotate a legacy non-Admin session without an employee profile and device binding', async () => {
    const harness = setup();
    const legacyToken = 'L'.repeat(43);
    const legacySession = session(ACCOUNT_ID, hashSessionToken(legacyToken));
    harness.repository.sessions.set(legacySession.id, legacySession);
    const principal = (await harness.service.authenticate(legacyToken)).principal;

    await expect(
      harness.service.changePassword(principal, {
        currentPassword: 'correct horse',
        newPassword: 'rotated password',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_CHANGED_CONCURRENTLY', statusCode: 409 });
    expect(harness.repository.sessions.size).toBe(1);
    expect(harness.repository.sessions.get(legacySession.id)?.deviceBindingId).toBeNull();
    expect(harness.repository.accounts.get(ACCOUNT_ID)?.passwordHash).toBe('hash:correct horse');
  });

  it('allows only Admin reset, revokes target sessions, and requires a password change', async () => {
    const target = account({ mustChangePassword: false });
    const admin = account({
      id: OTHER_ACCOUNT_ID,
      username: 'admin',
      employeeNik: null,
      role: UserRole.ADMIN,
      employeeId: null,
    });
    const harness = setup([target, admin]);
    const targetLogin = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    harness.setToken('D'.repeat(43));
    const adminLogin = await harness.service.login({
      identifier: 'admin',
      password: 'correct horse',
    });
    const adminPrincipal = (await harness.service.authenticate(adminLogin.cookieToken)).principal;
    await expect(
      harness.service.resetPassword(
        (await harness.service.authenticate(targetLogin.cookieToken)).principal,
        ACCOUNT_ID,
        'temporary password',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reset = await harness.service.resetPassword(
      adminPrincipal,
      ACCOUNT_ID,
      'temporary password',
    );

    expect(reset).toEqual({ accountId: ACCOUNT_ID, mustChangePassword: true });
    expect(harness.repository.accounts.get(ACCOUNT_ID)).toMatchObject({
      passwordHash: 'hash:temporary password',
      mustChangePassword: true,
    });
    expect(harness.auditEvents).toContainEqual(
      expect.objectContaining({
        actor: expect.objectContaining({ userAccountId: OTHER_ACCOUNT_ID, role: UserRole.ADMIN }),
        action: 'auth.password.reset',
        entityType: 'UserAccount',
        entityId: ACCOUNT_ID,
        before: { mustChangePassword: false },
        after: { mustChangePassword: true, sessionsRevoked: true },
        reason: 'admin_reset',
      }),
    );
    await expect(harness.service.authenticate(targetLogin.cookieToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      loginEmployee(harness.service, 'KaryawanA', 'temporary password'),
    ).resolves.toMatchObject({ user: { mustChangePassword: true } });
  });

  it('never includes password values or hashes in audit events', async () => {
    const harness = setup();
    const login = await loginEmployee(harness.service, 'KaryawanA', 'correct horse');
    const principal = (await harness.service.authenticate(login.cookieToken)).principal;
    await harness.service.changePassword(principal, {
      currentPassword: 'correct horse',
      newPassword: 'new-password-private',
    });
    const adminHarness = setup([account({ role: UserRole.ADMIN, employeeId: null })]);
    const adminLogin = await adminHarness.service.login({
      identifier: 'KaryawanA',
      password: 'correct horse',
    });
    const adminPrincipal = (await adminHarness.service.authenticate(adminLogin.cookieToken))
      .principal;
    await adminHarness.service.resetPassword(adminPrincipal, ACCOUNT_ID, 'temporary-private');

    const serialized = JSON.stringify([...harness.auditEvents, ...adminHarness.auditEvents]);
    expect(serialized).not.toContain('correct horse');
    expect(serialized).not.toContain('new-password-private');
    expect(serialized).not.toContain('temporary-private');
    expect(serialized).not.toContain('hash:');
  });
});
