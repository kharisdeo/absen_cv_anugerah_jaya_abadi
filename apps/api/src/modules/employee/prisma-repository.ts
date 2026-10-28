import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { acquireAccountIdentifierLock } from '../account/prisma-repository.js';
import type { EmployeeCreateData, EmployeeRecord, EmployeeRepository } from './index.js';

const employeeSelect = {
  id: true,
  nik: true,
  fullName: true,
  position: true,
  status: true,
  employmentDate: true,
  createdAt: true,
  updatedAt: true,
} as const;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof employeeSelect }>;
type EmployeeUpdateData = NonNullable<Parameters<EmployeeRepository['update']>[1]>;

function mapEmployee(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    nik: row.nik,
    fullName: row.fullName,
    position: row.position,
    status: row.status,
    employmentDate: row.employmentDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function nikConflict(): AppError {
  return new AppError(409, 'EMPLOYEE_NIK_CONFLICT', 'NIK sudah digunakan karyawan lain.');
}

function nikUsernameConflict(): AppError {
  return new AppError(
    409,
    'EMPLOYEE_NIK_USERNAME_CONFLICT',
    'NIK sudah digunakan sebagai username akun.',
  );
}

export class PrismaEmployeeRepository implements EmployeeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<readonly EmployeeRecord[]> {
    const rows = await this.prisma.employee.findMany({
      select: employeeSelect,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapEmployee);
  }

  async findById(id: string): Promise<EmployeeRecord | null> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      select: employeeSelect,
    });
    return row ? mapEmployee(row) : null;
  }

  async findByNik(nik: string): Promise<EmployeeRecord | null> {
    const row = await this.prisma.employee.findUnique({
      where: { nik },
      select: employeeSelect,
    });
    return row ? mapEmployee(row) : null;
  }

  async findAccountByUsername(username: string): Promise<Readonly<{ id: string }> | null> {
    return this.prisma.userAccount.findUnique({ where: { username }, select: { id: true } });
  }

  async create(data: EmployeeCreateData): Promise<EmployeeRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireAccountIdentifierLock(tx);
        const matchingAccount = await tx.userAccount.findUnique({
          where: { username: data.nik },
          select: { id: true },
        });
        if (matchingAccount) throw nikUsernameConflict();
        const row = await tx.employee.create({ data, select: employeeSelect });
        return mapEmployee(row);
      });
    } catch (error: unknown) {
      // This repository writes no other unique employee fields, so P2002 here is an NIK race.
      if (isPrismaCode(error, 'P2002')) throw nikConflict();
      throw error;
    }
  }

  async update(id: string, data: EmployeeUpdateData): Promise<EmployeeRecord | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireAccountIdentifierLock(tx);
        const before = await tx.employee.findUnique({ where: { id }, select: { nik: true } });
        if (!before) return null;
        if (data.nik !== undefined && data.nik !== before.nik) {
          const matchingAccount = await tx.userAccount.findUnique({
            where: { username: data.nik },
            select: { id: true },
          });
          if (matchingAccount) throw nikUsernameConflict();
        }
        const row = await tx.employee.update({ where: { id }, data, select: employeeSelect });
        return mapEmployee(row);
      });
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2002')) throw nikConflict();
      if (isPrismaCode(error, 'P2025')) return null;
      throw error;
    }
  }
}
