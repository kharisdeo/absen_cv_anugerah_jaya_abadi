import { createHash, randomBytes } from 'node:crypto';

import { AccountStatus, DeviceBindingStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';
import type { DeviceBindingService } from '../device-binding/index.js';
import type {
  AuthAccount,
  AuthenticatedSession,
  AuthPrincipal,
  AuthRepository,
  AuthRequestContext,
  ConsentStatusReader,
  LoginResult,
  PasswordHasher,
  PublicAuthUser,
} from './contracts.js';

const FAILURE_LIMIT = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const EMPLOYEE_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_PASSWORD_BYTES = 4_096;

export interface AuthServiceOptions {
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  audit: Pick<AuditService, 'record'>;
  /** A precomputed Argon2id hash used for unknown/ambiguous identifiers. */
  dummyPasswordHash: string;
  consentStatus: ConsentStatusReader;
  deviceBindings?: Pick<DeviceBindingService, 'enroll'>;
  now?: () => Date;
  createToken?: () => string;
}

function makeOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function userRoleActor(account: AuthAccount): AuditActor {
  switch (account.role) {
    case UserRole.ADMIN:
      return { userAccountId: account.id, role: UserRole.ADMIN };
    case UserRole.SUPERVISOR:
      return { userAccountId: account.id, role: UserRole.SUPERVISOR };
    case UserRole.EMPLOYEE:
      return {
        userAccountId: account.id,
        role: UserRole.EMPLOYEE,
        employeeId: account.employeeId,
      };
  }
}

function toPublicUser(
  account: AuthAccount,
  consentRequired: boolean,
  deviceBindingStatus: PublicAuthUser['deviceBindingStatus'],
): PublicAuthUser {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    employeeId: account.employeeId,
    deviceBindingStatus,
    mustChangePassword: account.mustChangePassword,
    consentRequired,
  };
}

function toPrincipal(
  account: AuthAccount,
  sessionId: string,
  lastSeenAt: Date,
  consentRequired: boolean,
  deviceBindingId: string | null,
  deviceBindingStatus: AuthPrincipal['deviceBindingStatus'],
): AuthPrincipal {
  return {
    userAccountId: account.id,
    role: account.role,
    username: account.username,
    employeeId: account.employeeId,
    deviceBindingId,
    deviceBindingStatus,
    mustChangePassword: account.mustChangePassword,
    consentRequired,
    sessionId,
    lastSeenAt,
  };
}

function invalidCredentials(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', 'Identifier atau password tidak valid.');
}

function requirePassword(password: unknown, field: string): asserts password is string {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw new AppError(400, 'INVALID_INPUT', `${field} tidak valid.`);
  }
}

function requireIdentifier(identifier: unknown): string {
  if (typeof identifier !== 'string') {
    throw new AppError(400, 'INVALID_INPUT', 'Identifier dan password wajib diisi.');
  }
  const trimmed = identifier.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) {
    throw new AppError(400, 'INVALID_INPUT', 'Identifier dan password wajib diisi.');
  }
  return trimmed;
}

function auditContext(context: AuthRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

function assertRegularAccess(principal: AuthPrincipal): void {
  if (principal.consentRequired) {
    throw new AppError(
      403,
      'CONSENT_REQUIRED',
      'Setujui kebijakan privasi terbaru terlebih dahulu untuk melanjutkan.',
    );
  }
  if (principal.mustChangePassword) {
    throw new AppError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Ganti password terlebih dahulu untuk melanjutkan.',
    );
  }
}

export class AuthService {
  private readonly now: () => Date;
  private readonly createToken: () => string;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createToken = options.createToken ?? makeOpaqueToken;
  }

  async login(
    input: Readonly<{
      identifier: unknown;
      password: unknown;
      deviceToken?: unknown;
      deviceName?: unknown;
    }>,
    context: AuthRequestContext = {},
  ): Promise<LoginResult> {
    const identifier = requireIdentifier(input.identifier);
    requirePassword(input.password, 'Password');
    const password = input.password;
    const now = this.now();
    const matches = await this.options.repository.findAccountsByIdentifier(identifier);
    const account = matches.length === 1 ? matches[0] : undefined;

    // Verify one hash in all cases. The dummy hash avoids an obvious timing distinction for
    // absent/ambiguous usernames without ever retaining or auditing the supplied password.
    let passwordMatches = false;
    try {
      passwordMatches = await this.options.passwordHasher.verify(
        account?.passwordHash ?? this.options.dummyPasswordHash,
        password,
      );
    } catch {
      passwordMatches = false;
    }

    const isLocked =
      account?.lockedUntil !== null &&
      account?.lockedUntil !== undefined &&
      account.lockedUntil > now;
    if (
      !account ||
      matches.length !== 1 ||
      account.status !== AccountStatus.ACTIVE ||
      isLocked ||
      !passwordMatches
    ) {
      if (
        account &&
        matches.length === 1 &&
        account.status === AccountStatus.ACTIVE &&
        !isLocked &&
        !passwordMatches
      ) {
        await this.options.repository.recordFailedLogin(
          account.id,
          now,
          FAILURE_LIMIT,
          LOCK_DURATION_MS,
        );
      }
      await this.options.audit.record({
        actor: null,
        action: 'auth.login.failure',
        entityType: 'UserAccount',
        entityId: matches.length === 1 ? (account?.id ?? null) : null,
        after: { outcome: 'failure', reason: 'invalid_credentials' },
        reason: 'invalid_credentials',
        ...auditContext(context),
      });
      throw invalidCredentials();
    }

    const consentRequired = await this.options.consentStatus.isConsentRequired(account.id);
    let deviceBindingId: string | null = null;
    if (account.role !== UserRole.ADMIN) {
      if (!account.employeeId) {
        throw new AppError(
          403,
          'EMPLOYEE_PROFILE_REQUIRED',
          'Profil karyawan belum tersedia. Hubungi Admin.',
        );
      }
      if (!this.options.deviceBindings) {
        throw new AppError(
          503,
          'DEVICE_ENROLLMENT_UNAVAILABLE',
          'Pendaftaran perangkat belum tersedia. Coba lagi nanti.',
        );
      }
      if (typeof input.deviceToken !== 'string' || typeof input.deviceName !== 'string') {
        throw new AppError(
          400,
          'DEVICE_INFO_REQUIRED',
          'Informasi perangkat wajib disertakan untuk login.',
        );
      }
      const binding = await this.options.deviceBindings.enroll(
        {
          userAccountId: account.id,
          employeeId: account.employeeId,
          role: account.role,
        },
        { deviceToken: input.deviceToken, deviceName: input.deviceName },
        context,
      );
      deviceBindingId = binding.id;
    }
    const cookieToken = this.createToken();
    const completed = await this.options.repository.completeLogin({
      accountId: account.id,
      expectedPasswordHash: account.passwordHash,
      deviceBindingId,
      tokenHash: hashSessionToken(cookieToken),
      now,
    });
    if (!completed) {
      await this.recordLoginFailure(context, account.id);
      throw invalidCredentials();
    }

    await this.options.audit.record({
      actor: userRoleActor(completed.account),
      action: 'auth.login.success',
      entityType: 'UserAccount',
      entityId: completed.account.id,
      after: { outcome: 'success', role: completed.account.role },
      ...auditContext(context),
    });
    return {
      cookieToken,
      user: toPublicUser(completed.account, consentRequired, completed.deviceBindingStatus),
    };
  }

  async authenticate(
    cookieToken: string | undefined,
    now = this.now(),
  ): Promise<AuthenticatedSession> {
    if (!cookieToken || cookieToken.length > 128) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
    }
    const record = await this.options.repository.findSessionByTokenHash(
      hashSessionToken(cookieToken),
    );
    if (!record || record.session.revokedAt !== null) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
    }
    if (record.account.status !== AccountStatus.ACTIVE) {
      await this.options.repository.revokeSession(record.session.id, now);
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
    }

    const idleTimeout =
      record.account.role === UserRole.ADMIN ? ADMIN_IDLE_TIMEOUT_MS : EMPLOYEE_IDLE_TIMEOUT_MS;
    if (now.getTime() - record.session.lastSeenAt.getTime() >= idleTimeout) {
      await this.options.repository.revokeSession(record.session.id, now);
      throw new AppError(401, 'SESSION_EXPIRED', 'Sesi tidak valid atau telah berakhir.');
    }
    if (!(await this.options.repository.touchSession(record.session.id, now))) {
      await this.options.repository.revokeSession(record.session.id, now);
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
    }

    const consentRequired = await this.options.consentStatus.isConsentRequired(record.account.id);
    const principal = toPrincipal(
      record.account,
      record.session.id,
      now,
      consentRequired,
      record.session.deviceBindingId,
      record.deviceBindingStatus,
    );
    return {
      principal,
      user: toPublicUser(record.account, consentRequired, record.deviceBindingStatus),
    };
  }

  async logout(principal: AuthPrincipal, context: AuthRequestContext = {}): Promise<void> {
    const now = this.now();
    await this.options.repository.revokeSession(principal.sessionId, now);
    await this.options.audit.record({
      actor: {
        userAccountId: principal.userAccountId,
        role: principal.role,
        ...(principal.role === UserRole.EMPLOYEE ? { employeeId: principal.employeeId } : {}),
      },
      action: 'auth.logout',
      entityType: 'UserAccount',
      entityId: principal.userAccountId,
      ...auditContext(context),
    });
  }

  async changePassword(
    principal: AuthPrincipal,
    input: Readonly<{ currentPassword: unknown; newPassword: unknown }>,
    context: AuthRequestContext = {},
  ): Promise<LoginResult> {
    requirePassword(input.currentPassword, 'Current password');
    requirePassword(input.newPassword, 'New password');
    const currentPassword = input.currentPassword;
    const newPassword = input.newPassword;
    const account = await this.options.repository.findAccountById(principal.userAccountId);
    if (
      !account ||
      account.status !== AccountStatus.ACTIVE ||
      !(await this.options.passwordHasher.verify(account.passwordHash, currentPassword))
    ) {
      throw new AppError(401, 'CURRENT_PASSWORD_INVALID', 'Password saat ini tidak valid.');
    }
    const newPasswordHash = await this.options.passwordHasher.hash(newPassword);
    const cookieToken = this.createToken();
    const now = this.now();
    const rotated = await this.options.repository.rotatePassword({
      accountId: account.id,
      expectedPasswordHash: account.passwordHash,
      newPasswordHash,
      deviceBindingId: principal.deviceBindingId,
      tokenHash: hashSessionToken(cookieToken),
      now,
    });
    if (!rotated) {
      throw new AppError(
        409,
        'PASSWORD_CHANGED_CONCURRENTLY',
        'Password telah berubah. Coba lagi.',
      );
    }
    await this.options.audit.record({
      actor: userRoleActor(rotated.account),
      action: 'auth.password.change',
      entityType: 'UserAccount',
      entityId: rotated.account.id,
      before: { mustChangePassword: account.mustChangePassword },
      after: { mustChangePassword: false, sessionsRevoked: true },
      ...auditContext(context),
    });
    return {
      cookieToken,
      user: toPublicUser(rotated.account, principal.consentRequired, rotated.deviceBindingStatus),
    };
  }

  async resetPassword(
    principal: AuthPrincipal,
    accountId: string,
    temporaryPassword: unknown,
    context: AuthRequestContext = {},
  ): Promise<Readonly<{ accountId: string; mustChangePassword: true }>> {
    assertRegularAccess(principal);
    if (principal.role !== UserRole.ADMIN) {
      throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat reset password.');
    }
    requirePassword(temporaryPassword, 'Temporary password');
    const newPasswordHash = await this.options.passwordHasher.hash(temporaryPassword);
    const now = this.now();
    const mutation = await this.options.repository.resetPassword(accountId, newPasswordHash, now);
    if (!mutation) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Akun tidak ditemukan.');
    }
    await this.options.audit.record({
      actor: {
        userAccountId: principal.userAccountId,
        role: principal.role,
      },
      action: 'auth.password.reset',
      entityType: 'UserAccount',
      entityId: mutation.after.id,
      before: { mustChangePassword: mutation.before.mustChangePassword },
      after: { mustChangePassword: mutation.after.mustChangePassword, sessionsRevoked: true },
      reason: 'admin_reset',
      ...auditContext(context),
    });
    return { accountId: mutation.after.id, mustChangePassword: true };
  }

  requireRegularAccess(principal: AuthPrincipal): void {
    assertRegularAccess(principal);
    if (
      principal.role !== UserRole.ADMIN &&
      principal.deviceBindingStatus !== DeviceBindingStatus.APPROVED
    ) {
      const code = principal.deviceBindingStatus
        ? `DEVICE_BINDING_${principal.deviceBindingStatus}`
        : 'DEVICE_BINDING_REQUIRED';
      const message =
        principal.deviceBindingStatus === DeviceBindingStatus.PENDING
          ? 'Perangkat menunggu persetujuan Admin.'
          : principal.deviceBindingStatus === DeviceBindingStatus.REVOKED
            ? 'Perangkat untuk sesi ini telah dicabut.'
            : 'Perangkat yang disetujui diperlukan untuk melanjutkan.';
      throw new AppError(403, code, message);
    }
  }

  private async recordLoginFailure(context: AuthRequestContext, accountId: string): Promise<void> {
    await this.options.audit.record({
      actor: null,
      action: 'auth.login.failure',
      entityType: 'UserAccount',
      entityId: accountId,
      after: { outcome: 'failure', reason: 'invalid_credentials' },
      reason: 'invalid_credentials',
      ...auditContext(context),
    });
  }
}
