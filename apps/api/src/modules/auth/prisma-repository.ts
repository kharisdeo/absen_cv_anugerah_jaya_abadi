import { AccountStatus, DeviceBindingStatus, UserRole } from '../../generated/prisma/enums.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { AuditLogRepository } from '../audit/index.js';
import { acquireDeviceBindingEmployeeLock } from '../device-binding/prisma-repository.js';
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
} from './contracts.js';

const accountInclude = { employee: { select: { id: true, nik: true } } } as const;
type AccountRow = Prisma.UserAccountGetPayload<{ include: typeof accountInclude }>;
type SessionWithAccountRow = Prisma.SessionGetPayload<{
  include: {
    userAccount: { include: typeof accountInclude };
    deviceBinding: { select: { status: true } };
  };
}>;

function mapAccount(row: AccountRow): AuthAccount {
  return {
    id: row.id,
    username: row.username,
    employeeNik: row.employee?.nik ?? null,
    passwordHash: row.passwordHash,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    failedLoginAttempts: row.failedLoginAttempts,
    lockedUntil: row.lockedUntil,
    lastLoginAt: row.lastLoginAt,
    employeeId: row.employee?.id ?? null,
  };
}

function mapSession(row: Prisma.SessionGetPayload<Record<string, never>>): AuthSession {
  return {
    id: row.id,
    userAccountId: row.userAccountId,
    deviceBindingId: row.deviceBindingId,
    tokenHash: row.tokenHash,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSessionWithAccount(row: SessionWithAccountRow): AuthSessionWithAccount {
  return {
    session: mapSession(row),
    account: mapAccount(row.userAccount),
    deviceBindingStatus: row.deviceBinding?.status ?? null,
  };
}

async function findAccount(
  client: Pick<PrismaClient, 'userAccount'>,
  accountId: string,
): Promise<AuthAccount | null> {
  const row = await client.userAccount.findUnique({
    where: { id: accountId },
    include: accountInclude,
  });
  return row ? mapAccount(row) : null;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAccountsByIdentifier(identifier: string): Promise<readonly AuthAccount[]> {
    const rows = await this.prisma.userAccount.findMany({
      where: {
        OR: [{ username: identifier }, { employee: { is: { nik: identifier } } }],
      },
      include: accountInclude,
      take: 2,
    });
    return rows.map(mapAccount);
  }

  async recordFailedLogin(
    accountId: string,
    now: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<LoginAttemptUpdate> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ status: string; failed_login_attempts: number; locked_until: Date | null }>
      >(Prisma.sql`
        SELECT "status", "failed_login_attempts", "locked_until"
        FROM "user_accounts"
        WHERE "id" = ${accountId}::uuid
        FOR UPDATE
      `);
      const current = rows[0];
      if (!current) return { failedLoginAttempts: 0, lockedUntil: null };
      const currentCount = Number(current.failed_login_attempts);
      if (current.status !== AccountStatus.ACTIVE) {
        return { failedLoginAttempts: currentCount, lockedUntil: current.locked_until };
      }
      if (current.locked_until && current.locked_until > now) {
        return { failedLoginAttempts: currentCount, lockedUntil: current.locked_until };
      }
      const failedLoginAttempts = (current.locked_until ? 0 : currentCount) + 1;
      const lockedUntil =
        failedLoginAttempts >= failureLimit ? new Date(now.getTime() + lockDurationMs) : null;
      await tx.userAccount.update({
        where: { id: accountId },
        data: { failedLoginAttempts, lockedUntil },
      });
      return { failedLoginAttempts, lockedUntil };
    });
  }

  async completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const accountLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "user_accounts"
        WHERE "id" = ${input.accountId}::uuid
        FOR UPDATE
      `);
      if (!accountLocks[0]) return null;
      const currentAccount = await findAccount(tx, input.accountId);
      if (!currentAccount) return null;

      let deviceBindingStatus: AuthSessionWithAccount['deviceBindingStatus'] = null;
      if (currentAccount.role !== UserRole.ADMIN) {
        if (!currentAccount.employeeId || !input.deviceBindingId) return null;
        await acquireDeviceBindingEmployeeLock(tx, currentAccount.employeeId);
        const binding = await tx.deviceBinding.findFirst({
          where: {
            id: input.deviceBindingId,
            employeeId: currentAccount.employeeId,
            status: { not: DeviceBindingStatus.REVOKED },
          },
          select: { id: true, status: true },
        });
        if (!binding) return null;
        deviceBindingStatus = binding.status;
      } else if (input.deviceBindingId !== null) {
        return null;
      }

      const update = await tx.userAccount.updateMany({
        where: {
          id: input.accountId,
          passwordHash: input.expectedPasswordHash,
          status: AccountStatus.ACTIVE,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: input.now } }],
        },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: input.now },
      });
      if (update.count !== 1) return null;
      const account = await findAccount(tx, input.accountId);
      if (!account) return null;
      const created = await tx.session.create({
        data: {
          userAccountId: input.accountId,
          deviceBindingId: input.deviceBindingId,
          tokenHash: input.tokenHash,
          lastSeenAt: input.now,
        },
      });
      return { account, session: mapSession(created), deviceBindingStatus };
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionWithAccount | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        userAccount: { include: accountInclude },
        deviceBinding: { select: { status: true } },
      },
    });
    return row ? mapSessionWithAccount(row) : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        userAccount: { is: { status: AccountStatus.ACTIVE } },
      },
      data: { lastSeenAt: now },
    });
    return result.count === 1;
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async revokeAccountSessions(accountId: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userAccountId: accountId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async findAccountById(accountId: string): Promise<AuthAccount | null> {
    return findAccount(this.prisma, accountId);
  }

  async resetPassword(
    accountId: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<PasswordResetMutation | null> {
    return this.prisma.$transaction(async (tx) => {
      const accountLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "user_accounts"
        WHERE "id" = ${accountId}::uuid
        FOR UPDATE
      `);
      if (!accountLocks[0]) return null;
      const before = await findAccount(tx, accountId);
      if (!before) return null;
      const update = await tx.userAccount.updateMany({
        where: { id: accountId },
        data: {
          passwordHash: newPasswordHash,
          mustChangePassword: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      if (update.count !== 1) return null;
      await tx.session.updateMany({
        where: { userAccountId: accountId, revokedAt: null },
        data: { revokedAt: now },
      });
      const after = await findAccount(tx, accountId);
      return after ? { before, after } : null;
    });
  }

  async rotatePassword(input: RotatePasswordInput): Promise<CompleteLoginResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const accountLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "user_accounts"
        WHERE "id" = ${input.accountId}::uuid
        FOR UPDATE
      `);
      if (!accountLocks[0]) return null;
      const currentAccount = await findAccount(tx, input.accountId);
      if (!currentAccount) return null;

      let deviceBindingStatus: AuthSessionWithAccount['deviceBindingStatus'] = null;
      if (currentAccount.role === UserRole.ADMIN) {
        if (input.deviceBindingId !== null) return null;
      } else {
        if (!currentAccount.employeeId || input.deviceBindingId === null) return null;
        await acquireDeviceBindingEmployeeLock(tx, currentAccount.employeeId);
        const binding = await tx.deviceBinding.findFirst({
          where: {
            id: input.deviceBindingId,
            employeeId: currentAccount.employeeId,
            status: { not: DeviceBindingStatus.REVOKED },
          },
          select: { id: true, status: true },
        });
        if (!binding) return null;
        deviceBindingStatus = binding.status;
      }

      const update = await tx.userAccount.updateMany({
        where: {
          id: input.accountId,
          passwordHash: input.expectedPasswordHash,
          status: AccountStatus.ACTIVE,
        },
        data: {
          passwordHash: input.newPasswordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      if (update.count !== 1) return null;
      await tx.session.updateMany({
        where: { userAccountId: input.accountId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      const account = await findAccount(tx, input.accountId);
      if (!account) return null;
      const created = await tx.session.create({
        data: {
          userAccountId: input.accountId,
          deviceBindingId: input.deviceBindingId,
          tokenHash: input.tokenHash,
          lastSeenAt: input.now,
        },
      });
      return { account, session: mapSession(created), deviceBindingStatus };
    });
  }
}

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: Parameters<AuditLogRepository['create']>[0]) {
    return this.prisma.auditLog.create({ data });
  }

  findMany(query: Parameters<AuditLogRepository['findMany']>[0]) {
    return this.prisma.auditLog.findMany({
      where: query.where,
      skip: query.skip,
      take: query.take,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
  }
}
