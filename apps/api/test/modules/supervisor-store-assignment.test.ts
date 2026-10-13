import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { UserRole } from '../../src/generated/prisma/enums.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import { PrismaSupervisorStoreAssignmentRepository } from '../../src/modules/supervisor-store-assignment/prisma-repository.js';
import {
  SupervisorStoreAssignmentService,
  type SupervisorStoreAssignmentRepository,
} from '../../src/modules/supervisor-store-assignment/index.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000301';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000302';
const STORE_ID = '00000000-0000-4000-8000-000000000303';
const REQUEST_ID = '00000000-0000-4000-8000-000000000304';

function principal(role: UserRole): AuthPrincipal {
  return {
    userAccountId: role === UserRole.ADMIN ? ADMIN_ID : SUPERVISOR_ID,
    role,
    username: role.toLowerCase(),
    employeeId: null,
    deviceBindingId: null,
    deviceBindingStatus: null,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: 'assignment-session',
    lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
  };
}

class MemoryAssignments implements SupervisorStoreAssignmentRepository {
  readonly list = vi.fn(async () => []);
  readonly create = vi.fn(async () => ({
    supervisorUserAccountId: SUPERVISOR_ID,
    supervisorUsername: 'supervisor-uji',
    storeId: STORE_ID,
    storeName: 'Toko Uji',
    assignedByUserAccountId: ADMIN_ID,
    assignedAt: new Date('2026-10-11T00:00:00.000Z'),
  }));
  readonly delete = vi.fn(async () => {});
}

function setupPrisma(options: { role?: UserRole; storeExists?: boolean } = {}) {
  const row = {
    supervisorUserAccountId: SUPERVISOR_ID,
    storeId: STORE_ID,
    assignedByUserAccountId: ADMIN_ID,
    assignedAt: new Date('2026-10-11T00:00:00.000Z'),
    supervisor: { username: 'supervisor-uji' },
    store: { name: 'Toko Uji' },
  };
  const tx = {
    userAccount: {
      findUnique: vi.fn(async () => ({ role: options.role ?? UserRole.SUPERVISOR })),
    },
    store: {
      findUnique: vi.fn(async () => (options.storeExists === false ? null : { id: STORE_ID })),
    },
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => row),
      findUnique: vi.fn(async () => ({
        supervisorUserAccountId: SUPERVISOR_ID,
        storeId: STORE_ID,
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
    supervisorStoreAssignment: { findMany: vi.fn(async () => []) },
  };
  return { tx, prisma, repository: new PrismaSupervisorStoreAssignmentRepository(prisma as never) };
}

describe('SupervisorStoreAssignmentService', () => {
  it.each([UserRole.SUPERVISOR, UserRole.EMPLOYEE])(
    'denies non-Admin assignment management for role %s',
    async (role) => {
      const repository = new MemoryAssignments();
      const service = new SupervisorStoreAssignmentService(repository);

      expect(() => service.list(principal(role))).toThrow(
        expect.objectContaining({ statusCode: 403 }),
      );
      expect(() =>
        service.create(
          principal(role),
          { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
          REQUEST_ID,
        ),
      ).toThrow(expect.objectContaining({ statusCode: 403 }));
      await expect(
        service.delete(
          principal(role),
          { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
          REQUEST_ID,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    },
  );

  it('derives the assignment actor from the authenticated Admin principal', async () => {
    const repository = new MemoryAssignments();
    const service = new SupervisorStoreAssignmentService(repository);

    await service.create(
      principal(UserRole.ADMIN),
      { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
      REQUEST_ID,
    );
    await service.delete(
      principal(UserRole.ADMIN),
      { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
      REQUEST_ID,
    );

    expect(repository.create).toHaveBeenCalledWith({
      supervisorUserAccountId: SUPERVISOR_ID,
      storeId: STORE_ID,
      assignedByUserAccountId: ADMIN_ID,
      requestId: REQUEST_ID,
    });
    expect(repository.delete).toHaveBeenCalledWith({
      supervisorUserAccountId: SUPERVISOR_ID,
      storeId: STORE_ID,
      assignedByUserAccountId: ADMIN_ID,
      requestId: REQUEST_ID,
    });
  });
});

describe('PrismaSupervisorStoreAssignmentRepository', () => {
  it('validates Supervisor/store targets and atomically records assignment plus audit', async () => {
    const { repository, tx, prisma } = setupPrisma();

    await expect(
      repository.create({
        supervisorUserAccountId: SUPERVISOR_ID,
        storeId: STORE_ID,
        assignedByUserAccountId: ADMIN_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID });

    expect(tx.userAccount.findUnique).toHaveBeenCalledWith({
      where: { id: SUPERVISOR_ID },
      select: { role: true },
    });
    expect(tx.store.findUnique).toHaveBeenCalledWith({
      where: { id: STORE_ID },
      select: { id: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserAccountId: ADMIN_ID,
        action: 'supervisor.store.assign',
        entityType: 'supervisor_store_assignment',
        entityId: `${SUPERVISOR_ID}:${STORE_ID}`,
        afterData: { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
        requestId: REQUEST_ID,
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('atomically records supervisor/store unassignment with its before snapshot', async () => {
    const { repository, tx } = setupPrisma();

    await repository.delete({
      supervisorUserAccountId: SUPERVISOR_ID,
      storeId: STORE_ID,
      assignedByUserAccountId: ADMIN_ID,
      requestId: REQUEST_ID,
    });

    expect(tx.supervisorStoreAssignment.deleteMany).toHaveBeenCalledWith({
      where: { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserAccountId: ADMIN_ID,
        action: 'supervisor.store.unassign',
        entityType: 'supervisor_store_assignment',
        entityId: `${SUPERVISOR_ID}:${STORE_ID}`,
        beforeData: { supervisorUserAccountId: SUPERVISOR_ID, storeId: STORE_ID },
        requestId: REQUEST_ID,
      },
    });
  });

  it('rejects non-Supervisor accounts and missing stores without creating a relation', async () => {
    const wrongRole = setupPrisma({ role: UserRole.EMPLOYEE });
    await expect(
      wrongRole.repository.create({
        supervisorUserAccountId: SUPERVISOR_ID,
        storeId: STORE_ID,
        assignedByUserAccountId: ADMIN_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'SUPERVISOR_ACCOUNT_REQUIRED' });
    expect(wrongRole.tx.supervisorStoreAssignment.create).not.toHaveBeenCalled();

    const missingStore = setupPrisma({ storeExists: false });
    await expect(
      missingStore.repository.create({
        supervisorUserAccountId: SUPERVISOR_ID,
        storeId: STORE_ID,
        assignedByUserAccountId: ADMIN_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'STORE_NOT_FOUND' });
    expect(missingStore.tx.supervisorStoreAssignment.create).not.toHaveBeenCalled();
  });

  it('maps duplicate assignment replay to 409 rather than writing a second audit', async () => {
    const setup = setupPrisma();
    setup.tx.supervisorStoreAssignment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );

    await expect(
      setup.repository.create({
        supervisorUserAccountId: SUPERVISOR_ID,
        storeId: STORE_ID,
        assignedByUserAccountId: ADMIN_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SUPERVISOR_STORE_ASSIGNMENT_EXISTS' });
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
