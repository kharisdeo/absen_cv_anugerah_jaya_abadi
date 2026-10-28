import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaSystemDisruptionRepository } from '../../src/modules/system-disruption/prisma-repository.js';

const STORE_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const START = new Date('2026-10-11T02:00:00.000Z');
const END = new Date('2026-10-11T04:00:00.000Z');
const KEY_HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

function prismaForeignKeyError() {
  return new Prisma.PrismaClientKnownRequestError('foreign key violation', {
    code: 'P2003',
    clientVersion: 'test',
  });
}

function prismaUniqueError() {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function createInput(id = '00000000-0000-4000-8000-000000000003') {
  return {
    id,
    storeId: STORE_ID,
    startsAt: START,
    endsAt: END,
    reason: 'Gangguan jaringan',
    createdByUserAccountId: ACTOR_ID,
    idempotencyKeyHash: KEY_HASH,
    requestFingerprint: FINGERPRINT,
  };
}

describe('PrismaSystemDisruptionRepository', () => {
  it('persists store or global scope and server-selected creator fields', async () => {
    const created = {
      id: '00000000-0000-4000-8000-000000000003',
      storeId: STORE_ID,
      startsAt: START,
      endsAt: END,
      reason: 'Gangguan jaringan',
      isActive: true,
      createdByUserAccountId: ACTOR_ID,
      createdAt: START,
      updatedAt: START,
    };
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(created);
    const transaction = { systemDisruption: { findUnique, create } };
    const prisma = {
      $transaction: vi.fn(async (callback: (transaction: never) => unknown) =>
        callback(transaction as never),
      ),
    };
    const repository = new PrismaSystemDisruptionRepository(prisma as never);
    const writeAudit = vi.fn().mockResolvedValue({});

    const result = await repository.createIdempotently(createInput(), writeAudit);

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        createdByUserAccountId_idempotencyKeyHash: {
          createdByUserAccountId: ACTOR_ID,
          idempotencyKeyHash: KEY_HASH,
        },
      },
      select: expect.objectContaining({ requestFingerprint: true, reason: true }),
    });
    expect(create).toHaveBeenCalledWith({
      data: createInput(),
      select: expect.objectContaining({ isActive: true, createdByUserAccountId: true }),
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ record: created, replayed: false });
  });

  it('maps a missing selected store to a safe 404', async () => {
    const transaction = {
      systemDisruption: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(prismaForeignKeyError()),
      },
    };
    const repository = new PrismaSystemDisruptionRepository({
      $transaction: vi.fn(async (callback: (transaction: never) => unknown) =>
        callback(transaction as never),
      ),
    } as never);

    await expect(repository.createIdempotently(createInput(), vi.fn())).rejects.toMatchObject({
      statusCode: 404,
      code: 'STORE_NOT_FOUND',
    });
  });

  it('replays a unique-key race without a second audit and conflicts on a different fingerprint', async () => {
    const winner = {
      id: '00000000-0000-4000-8000-000000000004',
      storeId: STORE_ID,
      startsAt: START,
      endsAt: END,
      reason: 'Gangguan jaringan',
      isActive: true,
      createdByUserAccountId: ACTOR_ID,
      createdAt: START,
      updatedAt: START,
      requestFingerprint: FINGERPRINT,
    };
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(prismaUniqueError()),
      systemDisruption: { findUnique: vi.fn().mockResolvedValue(winner) },
    };
    const repository = new PrismaSystemDisruptionRepository(prisma as never);
    const writeAudit = vi.fn();

    await expect(repository.createIdempotently(createInput(), writeAudit)).resolves.toEqual({
      record: winner,
      replayed: true,
    });
    expect(writeAudit.mock.calls).toHaveLength(0);
    await expect(
      repository.createIdempotently(
        { ...createInput(), requestFingerprint: 'c'.repeat(64) },
        writeAudit,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(writeAudit.mock.calls).toHaveLength(0);
  });

  it('lists records stably with an optional store filter and bounded pagination', async () => {
    const rows = [{ id: 'disruption-a' }, { id: 'disruption-b' }];
    const findMany = vi.fn(async () => rows);
    const repository = new PrismaSystemDisruptionRepository({
      systemDisruption: { findMany },
    } as never);

    const result = await repository.list({ storeId: STORE_ID, skip: 25, take: 26 });

    expect(findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      skip: 25,
      take: 26,
      select: expect.objectContaining({ reason: true, startsAt: true, endsAt: true }),
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    });
    expect(result).toEqual({ items: rows, hasNextPage: false });
  });

  it('does not filter global records out when no store filter is supplied', async () => {
    const findMany = vi.fn(async () => []);
    const repository = new PrismaSystemDisruptionRepository({
      systemDisruption: { findMany },
    } as never);

    await repository.list({ skip: 0, take: 26 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 26 }),
    );
  });
});
