import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  EmployeeStoreAssignmentRecord,
  StoreCreateData,
  StoreRecord,
  StoreRepository,
  StoreUpdateData,
} from './index.js';

const storeSelect = {
  id: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
  accuracyLimitMeters: true,
  wifiPublicIp: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const assignmentSelect = {
  storeId: true,
  employeeId: true,
  assignedByUserAccountId: true,
  assignedAt: true,
  employee: { select: { id: true, nik: true, fullName: true, status: true } },
} as const;

type StoreRow = Prisma.StoreGetPayload<{ select: typeof storeSelect }>;
type AssignmentRow = Prisma.EmployeeStoreGetPayload<{ select: typeof assignmentSelect }>;

function mapStore(row: StoreRow): StoreRecord {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude.toNumber(),
    longitude: row.longitude.toNumber(),
    radiusMeters: row.radiusMeters,
    accuracyLimitMeters: row.accuracyLimitMeters,
    wifiPublicIp: row.wifiPublicIp,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAssignment(row: AssignmentRow): EmployeeStoreAssignmentRecord {
  return {
    storeId: row.storeId,
    employeeId: row.employeeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    assignedAt: row.assignedAt,
    employee: {
      id: row.employee.id,
      nik: row.employee.nik,
      fullName: row.employee.fullName,
      status: row.employee.status,
    },
  };
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function missingRelatedRecord(): AppError {
  return new AppError(404, 'STORE_OR_EMPLOYEE_NOT_FOUND', 'Toko atau karyawan tidak ditemukan.');
}

export class PrismaStoreRepository implements StoreRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<readonly StoreRecord[]> {
    const rows = await this.prisma.store.findMany({
      select: storeSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapStore);
  }

  async findById(id: string): Promise<StoreRecord | null> {
    const row = await this.prisma.store.findUnique({ where: { id }, select: storeSelect });
    return row ? mapStore(row) : null;
  }

  async create(data: StoreCreateData): Promise<StoreRecord> {
    const row = await this.prisma.store.create({
      data: {
        ...data,
        latitude: new Prisma.Decimal(data.latitude.toString()),
        longitude: new Prisma.Decimal(data.longitude.toString()),
      },
      select: storeSelect,
    });
    return mapStore(row);
  }

  async update(id: string, data: StoreUpdateData): Promise<StoreRecord | null> {
    const updateData = {
      ...data,
      ...(data.latitude === undefined
        ? {}
        : { latitude: new Prisma.Decimal(data.latitude.toString()) }),
      ...(data.longitude === undefined
        ? {}
        : { longitude: new Prisma.Decimal(data.longitude.toString()) }),
    };
    try {
      const row = await this.prisma.store.update({
        where: { id },
        data: updateData,
        select: storeSelect,
      });
      return mapStore(row);
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2025')) return null;
      throw error;
    }
  }

  async findEmployeeById(id: string): Promise<EmployeeStoreAssignmentRecord['employee'] | null> {
    return this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, nik: true, fullName: true, status: true },
    });
  }

  async listAssignments(storeId: string): Promise<readonly EmployeeStoreAssignmentRecord[]> {
    const rows = await this.prisma.employeeStore.findMany({
      where: { storeId },
      select: assignmentSelect,
      orderBy: [{ assignedAt: 'asc' }, { employeeId: 'asc' }],
    });
    return rows.map(mapAssignment);
  }

  async findAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<EmployeeStoreAssignmentRecord | null> {
    const row = await this.prisma.employeeStore.findUnique({
      where: { employeeId_storeId: { employeeId, storeId } },
      select: assignmentSelect,
    });
    return row ? mapAssignment(row) : null;
  }

  async createAssignment(
    input: Readonly<{
      storeId: string;
      employeeId: string;
      assignedByUserAccountId: string;
    }>,
  ): Promise<Readonly<{ assignment: EmployeeStoreAssignmentRecord; created: boolean }>> {
    try {
      // INSERT .. ON CONFLICT DO NOTHING makes duplicate PUTs idempotent, including races.
      const inserted = await this.prisma.employeeStore.createMany({
        data: input,
        skipDuplicates: true,
      });
      const row = await this.findAssignment(input.storeId, input.employeeId);
      if (!row) throw missingRelatedRecord();
      return { assignment: row, created: inserted.count === 1 };
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2003')) throw missingRelatedRecord();
      throw error;
    }
  }

  async deleteAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<Readonly<{ removed: boolean; before: EmployeeStoreAssignmentRecord | null }>> {
    const before = await this.findAssignment(storeId, employeeId);
    if (!before) return { removed: false, before: null };
    const result = await this.prisma.employeeStore.deleteMany({ where: { storeId, employeeId } });
    return { removed: result.count === 1, before: result.count === 1 ? before : null };
  }
}
