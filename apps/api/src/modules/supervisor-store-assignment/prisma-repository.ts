import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  SupervisorStoreAssignmentDto,
  SupervisorStoreAssignmentFilter,
  SupervisorStoreAssignmentRepository,
} from './index.js';

const assignmentSelect = {
  supervisorUserAccountId: true,
  storeId: true,
  assignedByUserAccountId: true,
  assignedAt: true,
  supervisor: { select: { username: true } },
  store: { select: { name: true } },
} as const;

type AssignmentRow = Prisma.SupervisorStoreAssignmentGetPayload<{
  select: typeof assignmentSelect;
}>;
type AssignmentTransaction = Prisma.TransactionClient;

function mapAssignment(row: AssignmentRow): SupervisorStoreAssignmentDto {
  return {
    supervisorUserAccountId: row.supervisorUserAccountId,
    supervisorUsername: row.supervisor.username,
    storeId: row.storeId,
    storeName: row.store.name,
    assignedByUserAccountId: row.assignedByUserAccountId,
    assignedAt: row.assignedAt,
  };
}

function invalidSupervisor(): AppError {
  return new AppError(
    422,
    'SUPERVISOR_ACCOUNT_REQUIRED',
    'Akun tujuan harus memiliki peran Supervisor.',
  );
}

function assignmentNotFound(): AppError {
  return new AppError(
    404,
    'SUPERVISOR_STORE_ASSIGNMENT_NOT_FOUND',
    'Penugasan Supervisor tidak ditemukan.',
  );
}

function assignmentConflict(): AppError {
  return new AppError(409, 'SUPERVISOR_STORE_ASSIGNMENT_EXISTS', 'Penugasan Supervisor sudah ada.');
}

async function assertTargets(
  transaction: AssignmentTransaction,
  supervisorUserAccountId: string,
  storeId: string,
): Promise<void> {
  const [supervisor, store] = await Promise.all([
    transaction.userAccount.findUnique({
      where: { id: supervisorUserAccountId },
      select: { role: true },
    }),
    transaction.store.findUnique({ where: { id: storeId }, select: { id: true } }),
  ]);
  if (!supervisor || supervisor.role !== 'SUPERVISOR') throw invalidSupervisor();
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Toko tidak ditemukan.');
}

export class PrismaSupervisorStoreAssignmentRepository implements SupervisorStoreAssignmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(
    filter: SupervisorStoreAssignmentFilter,
  ): Promise<readonly SupervisorStoreAssignmentDto[]> {
    const rows = await this.prisma.supervisorStoreAssignment.findMany({
      where: {
        ...(filter.supervisorUserAccountId === undefined
          ? {}
          : { supervisorUserAccountId: filter.supervisorUserAccountId }),
        ...(filter.storeId === undefined ? {} : { storeId: filter.storeId }),
      },
      orderBy: [{ store: { name: 'asc' } }, { supervisor: { username: 'asc' } }],
      select: assignmentSelect,
    });
    return rows.map(mapAssignment);
  }

  async create(input: {
    supervisorUserAccountId: string;
    storeId: string;
    assignedByUserAccountId: string;
    requestId: string;
  }): Promise<SupervisorStoreAssignmentDto> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await assertTargets(transaction, input.supervisorUserAccountId, input.storeId);
          const row = await transaction.supervisorStoreAssignment.create({
            data: {
              supervisorUserAccountId: input.supervisorUserAccountId,
              storeId: input.storeId,
              assignedByUserAccountId: input.assignedByUserAccountId,
            },
            select: assignmentSelect,
          });
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: input.assignedByUserAccountId,
              action: 'supervisor.store.assign',
              entityType: 'supervisor_store_assignment',
              entityId: `${input.supervisorUserAccountId}:${input.storeId}`,
              afterData: {
                supervisorUserAccountId: input.supervisorUserAccountId,
                storeId: input.storeId,
              },
              requestId: input.requestId,
            },
          });
          return mapAssignment(row);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw assignmentConflict();
      }
      throw error;
    }
  }

  async delete(input: {
    supervisorUserAccountId: string;
    storeId: string;
    assignedByUserAccountId: string;
    requestId: string;
  }): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          const where = {
            supervisorUserAccountId_storeId: {
              supervisorUserAccountId: input.supervisorUserAccountId,
              storeId: input.storeId,
            },
          };
          const row = await transaction.supervisorStoreAssignment.findUnique({
            where,
            select: { supervisorUserAccountId: true, storeId: true },
          });
          if (!row) throw assignmentNotFound();
          const removed = await transaction.supervisorStoreAssignment.deleteMany({
            where: {
              supervisorUserAccountId: input.supervisorUserAccountId,
              storeId: input.storeId,
            },
          });
          if (removed.count !== 1) throw assignmentNotFound();
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: input.assignedByUserAccountId,
              action: 'supervisor.store.unassign',
              entityType: 'supervisor_store_assignment',
              entityId: `${row.supervisorUserAccountId}:${row.storeId}`,
              beforeData: {
                supervisorUserAccountId: row.supervisorUserAccountId,
                storeId: row.storeId,
              },
              requestId: input.requestId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2025')
      ) {
        throw assignmentNotFound();
      }
      throw error;
    }
  }
}
