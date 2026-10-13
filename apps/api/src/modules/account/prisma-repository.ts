import { AccountStatus, UserRole } from '../../generated/prisma/enums.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  AccountCreateData,
  AccountDto,
  AccountEmployeeLink,
  AccountMutation,
  AccountRepository,
  AccountUpdateData,
} from './index.js';

const accountSelect = {
  id: true,
  username: true,
  role: true,
  status: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
  employee: { select: { id: true } },
} as const;

const employeeSelect = { id: true, nik: true, accountId: true } as const;
type AccountRow = Prisma.UserAccountGetPayload<{ select: typeof accountSelect }>;
type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof employeeSelect }>;
type TransactionClient = Prisma.TransactionClient;

// Shared with the employee repository so username/NIK collision checks cannot race.
export const ACCOUNT_IDENTIFIER_LOCK_KEY = 0x41444d494e01n;

function mapAccount(row: AccountRow): AccountDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    employeeId: row.employee?.id ?? null,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEmployee(row: EmployeeRow): AccountEmployeeLink {
  return { id: row.id, nik: row.nik, accountId: row.accountId };
}

function isPrismaCode(error: unknown, code: string): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function p2002Conflict(error: Prisma.PrismaClientKnownRequestError): AppError {
  const target = error.meta?.target;
  const fields = (Array.isArray(target) ? target : [target]).map((field) =>
    String(field ?? '').toLowerCase(),
  );
  if (fields.some((field) => field.includes('username'))) {
    return new AppError(409, 'ACCOUNT_USERNAME_CONFLICT', 'Username sudah digunakan.');
  }
  if (fields.some((field) => field.includes('account_id') || field.includes('accountid'))) {
    return new AppError(
      409,
      'ACCOUNT_EMPLOYEE_LINK_CONFLICT',
      'Karyawan sudah terhubung ke akun lain.',
    );
  }
  return new AppError(
    409,
    'ACCOUNT_CONFLICT',
    'Data akun bertentangan dengan data yang sudah ada.',
  );
}

function invalidEmployeeLink(): AppError {
  return new AppError(400, 'INVALID_ACCOUNT_INPUT', 'Karyawan yang dipilih tidak ditemukan.');
}

function employeeLinkConflict(): AppError {
  return new AppError(
    409,
    'ACCOUNT_EMPLOYEE_LINK_CONFLICT',
    'Karyawan sudah terhubung ke akun lain.',
  );
}

function activeAdminFloorError(): AppError {
  return new AppError(
    409,
    'ACTIVE_ADMIN_FLOOR',
    'Setidaknya dua akun Admin aktif harus tetap tersedia.',
  );
}

async function findAccount(tx: TransactionClient, id: string): Promise<AccountDto | null> {
  const row = await tx.userAccount.findUnique({ where: { id }, select: accountSelect });
  return row ? mapAccount(row) : null;
}

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<readonly AccountDto[]> {
    const rows = await this.prisma.userAccount.findMany({
      select: accountSelect,
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapAccount);
  }

  async findById(id: string): Promise<AccountDto | null> {
    const row = await this.prisma.userAccount.findUnique({ where: { id }, select: accountSelect });
    return row ? mapAccount(row) : null;
  }

  async findByUsername(username: string): Promise<AccountDto | null> {
    const row = await this.prisma.userAccount.findUnique({
      where: { username },
      select: accountSelect,
    });
    return row ? mapAccount(row) : null;
  }

  async findEmployeeByNik(nik: string): Promise<AccountEmployeeLink | null> {
    const row = await this.prisma.employee.findUnique({ where: { nik }, select: employeeSelect });
    return row ? mapEmployee(row) : null;
  }

  async findEmployeeById(id: string): Promise<AccountEmployeeLink | null> {
    const row = await this.prisma.employee.findUnique({ where: { id }, select: employeeSelect });
    return row ? mapEmployee(row) : null;
  }

  async create(data: AccountCreateData): Promise<AccountDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(${ACCOUNT_IDENTIFIER_LOCK_KEY})`,
        );
        const matchingEmployee = await tx.employee.findUnique({
          where: { nik: data.username },
          select: { id: true },
        });
        if (matchingEmployee) {
          throw new AppError(
            409,
            'ACCOUNT_USERNAME_CONFLICT',
            'Username sudah digunakan oleh akun atau NIK karyawan.',
          );
        }

        const row = await tx.userAccount.create({
          data: {
            username: data.username,
            passwordHash: data.passwordHash,
            role: data.role,
            status: data.status,
            mustChangePassword: true,
            ...(data.employeeId ? { employee: { connect: { id: data.employeeId } } } : {}),
          },
          select: accountSelect,
        });
        return mapAccount(row);
      });
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2002')) throw p2002Conflict(error);
      if (isPrismaCode(error, 'P2025') || isPrismaCode(error, 'P2003')) throw invalidEmployeeLink();
      throw error;
    }
  }

  updateWithAdminFloor(id: string, data: AccountUpdateData): Promise<AccountMutation | null> {
    return this.mutateWithAdminFloor(id, data, false);
  }

  deactivateWithAdminFloor(id: string): Promise<AccountMutation | null> {
    return this.mutateWithAdminFloor(id, { status: AccountStatus.INACTIVE }, true);
  }

  private async mutateWithAdminFloor(
    id: string,
    data: AccountUpdateData,
    forceSessionRevocation: boolean,
  ): Promise<AccountMutation | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(${ACCOUNT_IDENTIFIER_LOCK_KEY})`,
        );

        const before = await findAccount(tx, id);
        if (!before) return null;

        if (data.username !== undefined && data.username !== before.username) {
          const matchingEmployee = await tx.employee.findUnique({
            where: { nik: data.username },
            select: { id: true },
          });
          if (matchingEmployee) {
            throw new AppError(
              409,
              'ACCOUNT_USERNAME_CONFLICT',
              'Username sudah digunakan oleh akun atau NIK karyawan.',
            );
          }
        }

        if (data.employeeId && data.employeeId !== before.employeeId) {
          const employee = await tx.employee.findUnique({
            where: { id: data.employeeId },
            select: { accountId: true },
          });
          if (!employee) throw invalidEmployeeLink();
          if (employee.accountId && employee.accountId !== id) throw employeeLinkConflict();
        }

        const nextRole = data.role ?? before.role;
        const nextStatus = data.status ?? before.status;
        const removesActiveAdmin =
          before.role === UserRole.ADMIN &&
          before.status === AccountStatus.ACTIVE &&
          (nextRole !== UserRole.ADMIN || nextStatus !== AccountStatus.ACTIVE);
        if (removesActiveAdmin) {
          const activeAdminCount = await tx.userAccount.count({
            where: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE },
          });
          if (activeAdminCount <= 2) throw activeAdminFloorError();
        }

        const changed =
          (data.username !== undefined && data.username !== before.username) ||
          (data.role !== undefined && data.role !== before.role) ||
          (data.status !== undefined && data.status !== before.status) ||
          (data.employeeId !== undefined && data.employeeId !== before.employeeId);

        let after = before;
        if (changed) {
          const updated = await tx.userAccount.update({
            where: { id },
            data: {
              ...(data.username === undefined ? {} : { username: data.username }),
              ...(data.role === undefined ? {} : { role: data.role }),
              ...(data.status === undefined ? {} : { status: data.status }),
              ...(data.employeeId === undefined || data.employeeId === before.employeeId
                ? {}
                : data.employeeId === null
                  ? { employee: { disconnect: true } }
                  : { employee: { connect: { id: data.employeeId } } }),
            },
            select: accountSelect,
          });
          after = mapAccount(updated);
        }

        if (forceSessionRevocation || before.role !== nextRole || before.status !== nextStatus) {
          await tx.session.updateMany({
            where: { userAccountId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return { before, after, changed };
      });
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2002')) throw p2002Conflict(error);
      if (isPrismaCode(error, 'P2003')) throw invalidEmployeeLink();
      if (isPrismaCode(error, 'P2025')) return null;
      throw error;
    }
  }
}
