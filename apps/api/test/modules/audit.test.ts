import { describe, expect, it, vi } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog, Prisma } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  AuditService,
  type AuditLogCreateData,
  type AuditLogFindManyQuery,
  type AuditLogRepository,
} from '../../src/modules/audit/index.js';
import type { AuthorizationActor } from '../../src/modules/authorization/index.js';

const accountId = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const databaseTime = new Date('2026-10-11T03:15:00.000Z');

function makeAuditLog(data: AuditLogCreateData, occurredAt = databaseTime): AuditLog {
  return {
    id: 'f6465af6-9fb2-46e7-832f-a835c0644d69',
    actorUserAccountId: data.actorUserAccountId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId,
    beforeData: (data.beforeData as Prisma.JsonValue | undefined) ?? null,
    afterData: (data.afterData as Prisma.JsonValue | undefined) ?? null,
    reason: data.reason,
    clientIp: data.clientIp,
    deviceIdHash: data.deviceIdHash,
    requestId: data.requestId,
    occurredAt,
  };
}

function makeFakeRepository(rows: readonly AuditLog[] = []) {
  const created: AuditLogCreateData[] = [];
  const queries: AuditLogFindManyQuery[] = [];
  const repository: AuditLogRepository = {
    async create(data) {
      created.push(data);
      return makeAuditLog(data);
    },
    async findMany(query) {
      queries.push(query);
      return rows;
    },
  };
  return { repository, created, queries };
}

const admin: AuthorizationActor = { role: UserRole.ADMIN };
const employee: AuthorizationActor = { role: UserRole.EMPLOYEE, employeeId: 'employee-1' };
const supervisor: AuthorizationActor = { role: UserRole.SUPERVISOR, supervisorScope: [] };

describe('AuditService', () => {
  it('records server-authored event fields and lets the repository supply occurredAt', async () => {
    const fake = makeFakeRepository();
    const service = new AuditService(fake.repository);
    const event = await service.record({
      actor: { role: UserRole.ADMIN, userAccountId: accountId },
      action: 'employee.update',
      entityType: 'employee',
      entityId: 'employee-42',
      before: { status: 'ACTIVE' },
      after: { status: 'INACTIVE' },
      reason: 'Perubahan status',
      clientIp: '192.0.2.10',
      deviceIdHash: 'a'.repeat(64),
      requestId: 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9',
    });

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      actorUserAccountId: accountId,
      action: 'employee.update',
      entityType: 'employee',
      entityId: 'employee-42',
      beforeData: { status: 'ACTIVE' },
      afterData: { status: 'INACTIVE' },
      clientIp: '192.0.2.10',
      deviceIdHash: 'a'.repeat(64),
      requestId: 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9',
    });
    expect(fake.created[0]).not.toHaveProperty('occurredAt');
    expect(event.occurredAt).toEqual(databaseTime);
  });

  it('writes an atomic audit event through the supplied Prisma transaction', async () => {
    const fake = makeFakeRepository();
    const create = vi.fn(async ({ data }: { data: AuditLogCreateData }) => makeAuditLog(data));
    const transaction = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await new AuditService(fake.repository).recordInTransaction(transaction, {
      actor: { role: UserRole.ADMIN, userAccountId: accountId },
      action: 'system_disruption.create',
      entityType: 'system_disruption',
      entityId: '8b3d9c90-1075-4e40-8ca7-1ad1f4dbdbaa',
      after: { storeId: null, isActive: true },
      reason: 'Gangguan sistem',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserAccountId: accountId,
        action: 'system_disruption.create',
        entityType: 'system_disruption',
        reason: 'Gangguan sistem',
      }),
    });
    expect(fake.created).toEqual([]);
  });

  it('allows system events with a null actor', async () => {
    const fake = makeFakeRepository();
    await new AuditService(fake.repository).record({
      actor: null,
      action: 'system.backup.completed',
      entityType: 'backup',
    });
    expect(fake.created[0]?.actorUserAccountId).toBeNull();
  });

  it('drops sensitive keys recursively from before/after snapshots', async () => {
    const fake = makeFakeRepository();
    await new AuditService(fake.repository).record({
      actor: null,
      action: 'device.approve',
      entityType: 'device',
      before: {
        status: 'PENDING',
        password: 'must-not-persist',
        nested: {
          access_token: 'must-not-persist',
          selfiePhoto: 'must-not-persist',
          latitude: -6.2,
          lon: 106.8,
          storeId: 'store-1',
        },
      },
      after: {
        status: 'APPROVED',
        cookie: 'must-not-persist',
        gpsProof: 'must-not-persist',
        secretValue: 'must-not-persist',
      },
    });

    expect(fake.created[0]?.beforeData).toEqual({
      status: 'PENDING',
      nested: { storeId: 'store-1' },
    });
    expect(fake.created[0]?.afterData).toEqual({ status: 'APPROVED' });
    expect(JSON.stringify(fake.created[0])).not.toContain('must-not-persist');
  });

  it('preserves only top-level store geofence coordinates for Admin store change audits', async () => {
    const fake = makeFakeRepository();
    const service = new AuditService(fake.repository);
    await service.record({
      actor: { role: UserRole.ADMIN, userAccountId: accountId },
      action: 'store.update',
      entityType: 'store',
      before: {
        latitude: -6.2,
        longitude: 106.8,
        location: 'must-not-persist',
        nested: { latitude: 1 },
      },
      after: { latitude: -6.3, longitude: 106.9 },
    });

    expect(fake.created[0]?.beforeData).toEqual({ latitude: -6.2, longitude: 106.8, nested: {} });
    expect(fake.created[0]?.afterData).toEqual({ latitude: -6.3, longitude: 106.9 });

    await service.record({
      actor: { role: UserRole.ADMIN, userAccountId: accountId },
      action: 'store.read',
      entityType: 'store',
      before: { latitude: -6.2, longitude: 106.8 },
    });
    expect(fake.created[1]?.beforeData).toEqual({});
  });

  it('allows only Admin to read and uses bounded filters and pagination', async () => {
    const fake = makeFakeRepository([
      makeAuditLog({
        actorUserAccountId: accountId,
        action: 'attendance.approve',
        entityType: 'attendance',
        entityId: 'attendance-1',
        reason: null,
        clientIp: null,
        deviceIdHash: null,
        requestId: null,
      }),
    ]);
    const service = new AuditService(fake.repository);

    const page = await service.list(admin, {
      actorUserAccountId: accountId,
      action: 'attendance.approve',
      entityType: 'attendance',
      entityId: 'attendance-1',
      from: '2026-10-01T00:00:00+07:00',
      to: '2026-10-31T23:59:59+07:00',
      page: 2,
      pageSize: 10,
    });

    expect(fake.queries[0]).toMatchObject({
      where: {
        actorUserAccountId: accountId,
        action: 'attendance.approve',
        entityType: 'attendance',
        entityId: 'attendance-1',
        occurredAt: {
          gte: new Date('2026-09-30T17:00:00.000Z'),
          lte: new Date('2026-10-31T16:59:59.000Z'),
        },
      },
      skip: 10,
      take: 11,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    expect(page).toMatchObject({ page: 2, pageSize: 10, hasNextPage: false });
    expect(page.items).toHaveLength(1);
  });

  it('rejects Employee and Supervisor reads before touching the repository', async () => {
    const fake = makeFakeRepository();
    const service = new AuditService(fake.repository);

    for (const actor of [employee, supervisor]) {
      await expect(service.list(actor)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      } satisfies Partial<AppError>);
    }
    expect(fake.queries).toHaveLength(0);
  });

  it('rejects excessive pagination and unsupported filter parameters', async () => {
    const service = new AuditService(makeFakeRepository().repository);
    await expect(service.list(admin, { pageSize: 101 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.list(admin, { page: 1, role: UserRole.ADMIN } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects impossible calendar, clock, and UTC-offset components in timestamp filters', async () => {
    const fake = makeFakeRepository();
    const service = new AuditService(fake.repository);
    const invalidTimestamps = [
      '2026-02-30T03:00:00.000Z',
      '0000-10-11T03:00:00.000Z',
      '2026-10-11T24:00:00.000Z',
      '2026-10-11T03:60:00.000Z',
      '2026-10-11T03:00:60.000Z',
      '2026-10-11T03:00:00.000+24:00',
      '2026-10-11T03:00:00.000+01:60',
    ];

    for (const from of invalidTimestamps) {
      await expect(service.list(admin, { from })).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_AUDIT_INPUT',
      });
    }
    expect(fake.queries).toHaveLength(0);

    await service.list(admin, { from: '2024-02-29T23:59:59.999+14:00' });
    expect(fake.queries[0]?.where.occurredAt?.gte).toEqual(new Date('2024-02-29T09:59:59.999Z'));
  });
});
