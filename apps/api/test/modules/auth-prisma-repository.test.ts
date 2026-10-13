import { describe, expect, it, vi } from 'vitest';

import { AccountStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaAuthRepository } from '../../src/modules/auth/prisma-repository.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000401';
const NOW = new Date('2026-10-11T03:15:00.000Z');

describe('PrismaAuthRepository.resetPassword', () => {
  it('returns the locked pre-update and post-update account snapshots from one transaction', async () => {
    const before = {
      id: ACCOUNT_ID,
      username: 'karyawan-uji',
      employee: null,
      passwordHash: 'prior-hash',
      role: UserRole.EMPLOYEE,
      status: AccountStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 4,
      lockedUntil: new Date('2026-10-11T04:00:00.000Z'),
      lastLoginAt: null,
    };
    const after = {
      ...before,
      passwordHash: 'replacement-hash',
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    const tx = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        void query;
        return [{ id: ACCOUNT_ID }];
      }),
      userAccount: {
        findUnique: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      session: { updateMany: vi.fn(async () => ({ count: 2 })) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const repository = new PrismaAuthRepository(prisma as never);

    const mutation = await repository.resetPassword(ACCOUNT_ID, 'replacement-hash', NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const lockQuery = tx.$queryRaw.mock.calls[0]?.[0];
    expect(lockQuery?.sql).toContain('FOR UPDATE');
    expect(lockQuery?.values).toContain(ACCOUNT_ID);
    expect(tx.userAccount.updateMany).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: {
        passwordHash: 'replacement-hash',
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { userAccountId: ACCOUNT_ID, revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(mutation).toMatchObject({
      before: { mustChangePassword: false, failedLoginAttempts: 4, passwordHash: 'prior-hash' },
      after: { mustChangePassword: true, failedLoginAttempts: 0, passwordHash: 'replacement-hash' },
    });
  });
});
