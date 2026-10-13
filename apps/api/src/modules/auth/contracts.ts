import type { AccountStatus, DeviceBindingStatus, UserRole } from '../../generated/prisma/enums.js';

export type AuthAccount = Readonly<{
  id: string;
  username: string;
  employeeNik: string | null;
  passwordHash: string;
  role: UserRole;
  status: AccountStatus;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  employeeId: string | null;
}>;

export type AuthSession = Readonly<{
  id: string;
  userAccountId: string;
  deviceBindingId: string | null;
  tokenHash: string;
  lastSeenAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AuthSessionWithAccount = Readonly<{
  session: AuthSession;
  account: AuthAccount;
  deviceBindingStatus: DeviceBindingStatus | null;
}>;

export type LoginAttemptUpdate = Readonly<{
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}>;

export type CompleteLoginInput = Readonly<{
  accountId: string;
  expectedPasswordHash: string;
  deviceBindingId: string | null;
  tokenHash: string;
  now: Date;
}>;

export type CompleteLoginResult = Readonly<{
  account: AuthAccount;
  session: AuthSession;
  deviceBindingStatus: DeviceBindingStatus | null;
}>;

export type PasswordResetMutation = Readonly<{
  before: AuthAccount;
  after: AuthAccount;
}>;

export type RotatePasswordInput = Readonly<{
  accountId: string;
  expectedPasswordHash: string;
  newPasswordHash: string;
  deviceBindingId: string | null;
  tokenHash: string;
  now: Date;
}>;

/** Persistence methods that mutate credentials/session state must be atomic transactions. */
export interface AuthRepository {
  findAccountsByIdentifier(identifier: string): Promise<readonly AuthAccount[]>;
  recordFailedLogin(
    accountId: string,
    now: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<LoginAttemptUpdate>;
  completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult | null>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSessionWithAccount | null>;
  touchSession(sessionId: string, now: Date): Promise<boolean>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  revokeAccountSessions(accountId: string, now: Date): Promise<void>;
  findAccountById(accountId: string): Promise<AuthAccount | null>;
  resetPassword(
    accountId: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<PasswordResetMutation | null>;
  rotatePassword(input: RotatePasswordInput): Promise<CompleteLoginResult | null>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/** Server-side consent status derived from the active policy and persisted consent record. */
export interface ConsentStatusReader {
  isConsentRequired(userAccountId: string): Promise<boolean>;
}

export type AuthPrincipal = Readonly<{
  userAccountId: string;
  role: UserRole;
  username: string;
  employeeId: string | null;
  deviceBindingId: string | null;
  deviceBindingStatus: DeviceBindingStatus | null;
  mustChangePassword: boolean;
  consentRequired: boolean;
  sessionId: string;
  lastSeenAt: Date;
}>;

export type AuthRequestContext = Readonly<{
  clientIp?: string;
  requestId?: string;
}>;

export type PublicAuthUser = Readonly<{
  id: string;
  username: string;
  role: UserRole;
  employeeId: string | null;
  deviceBindingStatus: DeviceBindingStatus | null;
  mustChangePassword: boolean;
  consentRequired: boolean;
}>;

export type LoginResult = Readonly<{
  /** The raw token is returned only to the HTTP layer so it can be set as an HttpOnly cookie. */
  cookieToken: string;
  user: PublicAuthUser;
}>;

export type AuthenticatedSession = Readonly<{
  principal: AuthPrincipal;
  user: PublicAuthUser;
}>;
