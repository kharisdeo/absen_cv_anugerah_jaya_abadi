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
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

function storeNotFound(): AppError {
  return new AppError(404, 'STORE_NOT_FOUND', 'Toko tidak ditemukan.');
}

export class PrismaSystemDisruptionRepository implements SystemDisruptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Parameters<SystemDisruptionRepository['create']>[0]) {
    try {
      return await this.prisma.systemDisruption.create({
        data: input,
        select: disruptionSelect,
      });
    } catch (error: unknown) {
      if (input.storeId !== null && isForeignKeyError(error)) throw storeNotFound();
      throw error;
    }
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
