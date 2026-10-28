import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type { SystemDisruptionRepository } from './index.js';

const disruptionSelect = {
  id: true,
  storeId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  isActive: true,
  createdByUserAccountId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isForeignKeyError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error as { code?: unknown }).code === 'P2003'
  );
}

function storeNotFound(): AppError {
  return new AppError(404, 'STORE_NOT_FOUND', 'Toko tidak ditemukan.');
}

export class PrismaSystemDisruptionRepository implements SystemDisruptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createIdempotently(
    input: Parameters<SystemDisruptionRepository['createIdempotently']>[0],
    writeAudit: Parameters<SystemDisruptionRepository['createIdempotently']>[1],
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.systemDisruption.findUnique({
          where: {
            createdByUserAccountId_idempotencyKeyHash: {
              createdByUserAccountId: input.createdByUserAccountId,
              idempotencyKeyHash: input.idempotencyKeyHash,
            },
          },
          select: { ...disruptionSelect, requestFingerprint: true },
        });
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict();
          return { record: existing, replayed: true };
        }

        const record = await transaction.systemDisruption.create({
          data: input,
          select: disruptionSelect,
        });
        await writeAudit(transaction);
        return { record, replayed: false };
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.findByIdempotencyKey(input);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict();
          return { record: existing, replayed: true };
        }
      }
      if (input.storeId !== null && isForeignKeyError(error)) throw storeNotFound();
      throw error;
    }
  }

  private findByIdempotencyKey(
    input: Parameters<SystemDisruptionRepository['createIdempotently']>[0],
  ) {
    return this.prisma.systemDisruption.findUnique({
      where: {
        createdByUserAccountId_idempotencyKeyHash: {
          createdByUserAccountId: input.createdByUserAccountId,
          idempotencyKeyHash: input.idempotencyKeyHash,
        },
      },
      select: { ...disruptionSelect, requestFingerprint: true },
    });
  }

  async list(input: Parameters<SystemDisruptionRepository['list']>[0]) {
    const rows = await this.prisma.systemDisruption.findMany({
      where: input.storeId === undefined ? {} : { storeId: input.storeId },
      skip: input.skip,
      take: input.take,
      select: disruptionSelect,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    });
    return {
      items: rows,
      hasNextPage: rows.length === input.take,
    };
  }
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key sudah digunakan untuk payload yang berbeda.',
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
