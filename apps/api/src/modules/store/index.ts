import { isIP } from 'node:net';

import { EmployeeStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoreRecord = Readonly<{
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
  wifiPublicIp: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type StoreDto = Readonly<{
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
  wifiPublicIp: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type EmployeeStoreAssignmentRecord = Readonly<{
  storeId: string;
  employeeId: string;
  assignedByUserAccountId: string | null;
  assignedAt: Date;
  employee: Readonly<{
    id: string;
    nik: string;
    fullName: string;
    status: EmployeeStatus;
  }>;
}>;

export type EmployeeStoreAssignmentDto = Readonly<{
  storeId: string;
  employeeId: string;
  assignedByUserAccountId: string | null;
  assignedAt: string;
  employee: EmployeeStoreAssignmentRecord['employee'];
}>;

export type StoreCreateData = Readonly<{
  name: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  /** Omitted values use the Prisma schema defaults from the PRD: 10 m and 30 m. */
  radiusMeters?: number;
  accuracyLimitMeters?: number;
  wifiPublicIp?: string | null;
  isActive?: boolean;
}>;

export type StoreUpdateData = Readonly<Partial<StoreCreateData>>;

export interface StoreRepository {
  list(): Promise<readonly StoreRecord[]>;
  findById(id: string): Promise<StoreRecord | null>;
  create(data: StoreCreateData): Promise<StoreRecord>;
  update(id: string, data: StoreUpdateData): Promise<StoreRecord | null>;
  findEmployeeById(id: string): Promise<EmployeeStoreAssignmentRecord['employee'] | null>;
  listAssignments(storeId: string): Promise<readonly EmployeeStoreAssignmentRecord[]>;
  findAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<EmployeeStoreAssignmentRecord | null>;
  createAssignment(
    input: Readonly<{
      storeId: string;
      employeeId: string;
      assignedByUserAccountId: string;
    }>,
  ): Promise<Readonly<{ assignment: EmployeeStoreAssignmentRecord; created: boolean }>>;
  deleteAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<Readonly<{ removed: boolean; before: EmployeeStoreAssignmentRecord | null }>>;
}

export type StoreRequestContext = Readonly<{ clientIp?: string; requestId?: string }>;

function invalidInput(message = 'Data toko atau penugasan tidak valid.'): AppError {
  return new AppError(400, 'INVALID_STORE_INPUT', message);
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola toko.');
  }
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return value.toLowerCase();
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalidInput(`${field} wajib berupa teks.`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (value === undefined) throw invalidInput(`${field} tidak valid.`);
  return normalizeText(value, field, maxLength);
}

function hasAtMostSixDecimalPlaces(value: number): boolean {
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const fractionalDigits = (mantissa!.split('.')[1]?.length ?? 0) - Number(exponentText ?? 0);
  return fractionalDigits <= 6;
}

function normalizeCoordinate(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    !hasAtMostSixDecimalPlaces(value)
  ) {
    throw invalidInput(
      `${field} harus berada pada rentang ${minimum} sampai ${maximum} dengan maksimal 6 angka desimal.`,
    );
  }
  return value;
}

function normalizePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw invalidInput(
      `${field} harus berupa bilangan bulat positif yang dapat disimpan database.`,
    );
  }
  return value;
}

function normalizeWifiPublicIp(value: unknown): string | null {
  if (value === null) return null;
  const normalized = normalizeText(value, 'IP Wi-Fi publik', 45);
  // Some supported Node runtimes accept scoped IPv6 literals; PostgreSQL inet input
  // and the documented contract here are deliberately limited to plain IP literals.
  if (normalized.includes('%') || isIP(normalized) === 0)
    throw invalidInput('IP Wi-Fi publik harus berupa alamat IPv4 atau IPv6 yang valid.');
  return normalized;
}

function normalizeIsActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidInput('Status aktif harus berupa boolean.');
  return value;
}

function normalizeCreate(input: StoreCreateData): StoreCreateData {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  const result: {
    name: string;
    address?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    accuracyLimitMeters?: number;
    wifiPublicIp?: string | null;
    isActive?: boolean;
  } = {
    name: normalizeText(input.name, 'Nama toko', 160),
    latitude: normalizeCoordinate(input.latitude, 'Latitude', -90, 90),
    longitude: normalizeCoordinate(input.longitude, 'Longitude', -180, 180),
  };
  if (input.address !== undefined)
    result.address = normalizeOptionalText(input.address, 'Alamat toko', 500);
  if (input.radiusMeters !== undefined)
    result.radiusMeters = normalizePositiveInt(input.radiusMeters, 'Radius');
  if (input.accuracyLimitMeters !== undefined) {
    result.accuracyLimitMeters = normalizePositiveInt(input.accuracyLimitMeters, 'Batas akurasi');
  }
  if (input.wifiPublicIp !== undefined)
    result.wifiPublicIp = normalizeWifiPublicIp(input.wifiPublicIp);
  if (input.isActive !== undefined) result.isActive = normalizeIsActive(input.isActive);
  return result;
}

function normalizeUpdate(input: StoreUpdateData): StoreUpdateData {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  const result: {
    name?: string;
    address?: string | null;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    accuracyLimitMeters?: number;
    wifiPublicIp?: string | null;
    isActive?: boolean;
  } = {};
  if (input.name !== undefined) result.name = normalizeText(input.name, 'Nama toko', 160);
  if (input.address !== undefined)
    result.address = normalizeOptionalText(input.address, 'Alamat toko', 500);
  if (input.latitude !== undefined)
    result.latitude = normalizeCoordinate(input.latitude, 'Latitude', -90, 90);
  if (input.longitude !== undefined)
    result.longitude = normalizeCoordinate(input.longitude, 'Longitude', -180, 180);
  if (input.radiusMeters !== undefined)
    result.radiusMeters = normalizePositiveInt(input.radiusMeters, 'Radius');
  if (input.accuracyLimitMeters !== undefined) {
    result.accuracyLimitMeters = normalizePositiveInt(input.accuracyLimitMeters, 'Batas akurasi');
  }
  if (input.wifiPublicIp !== undefined)
    result.wifiPublicIp = normalizeWifiPublicIp(input.wifiPublicIp);
  if (input.isActive !== undefined) result.isActive = normalizeIsActive(input.isActive);
  if (Object.keys(result).length === 0) throw invalidInput('Tidak ada data toko yang diperbarui.');
  return result;
}

function storeDto(row: StoreRecord): StoreDto {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radiusMeters,
    accuracyLimitMeters: row.accuracyLimitMeters,
    wifiPublicIp: row.wifiPublicIp,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assignmentDto(row: EmployeeStoreAssignmentRecord): EmployeeStoreAssignmentDto {
  return {
    storeId: row.storeId,
    employeeId: row.employeeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    assignedAt: row.assignedAt.toISOString(),
    employee: row.employee,
  };
}

function storeSnapshot(row: StoreDto): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radiusMeters,
    accuracyLimitMeters: row.accuracyLimitMeters,
    wifiPublicIp: row.wifiPublicIp,
    isActive: row.isActive,
  };
}

function assignmentSnapshot(row: EmployeeStoreAssignmentDto): Record<string, unknown> {
  return {
    storeId: row.storeId,
    employeeId: row.employeeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    assignedAt: row.assignedAt,
  };
}

function auditContext(context: StoreRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

function notFound(kind: 'store' | 'employee' = 'store'): AppError {
  return kind === 'store'
    ? new AppError(404, 'STORE_NOT_FOUND', 'Toko tidak ditemukan.')
    : new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Karyawan tidak ditemukan.');
}

export class StoreService {
  constructor(
    private readonly repository: StoreRepository,
    private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  async list(actor: AuditActor): Promise<readonly StoreDto[]> {
    assertAdmin(actor);
    return (await this.repository.list()).map(storeDto);
  }

  async get(actor: AuditActor, storeId: string): Promise<StoreDto> {
    assertAdmin(actor);
    const row = await this.repository.findById(normalizeId(storeId, 'ID toko'));
    if (!row) throw notFound();
    return storeDto(row);
  }

  async create(
    actor: AuditActor,
    input: StoreCreateData,
    context: StoreRequestContext = {},
  ): Promise<StoreDto> {
    assertAdmin(actor);
    const created = storeDto(await this.repository.create(normalizeCreate(input)));
    await this.audit.record({
      actor,
      action: 'store.create',
      entityType: 'store',
      entityId: created.id,
      after: storeSnapshot(created),
      ...auditContext(context),
    });
    return created;
  }

  async update(
    actor: AuditActor,
    storeId: string,
    input: StoreUpdateData,
    context: StoreRequestContext = {},
  ): Promise<StoreDto> {
    assertAdmin(actor);
    const id = normalizeId(storeId, 'ID toko');
    const before = await this.repository.findById(id);
    if (!before) throw notFound();
    const data = normalizeUpdate(input);
    const current = storeDto(before);
    const changed = Object.entries(data).some(
      ([key, value]) => current[key as keyof StoreDto] !== value,
    );
    if (!changed) return current;
    const updated = await this.repository.update(id, data);
    if (!updated) throw notFound();
    const after = storeDto(updated);
    await this.audit.record({
      actor,
      action: 'store.update',
      entityType: 'store',
      entityId: id,
      before: storeSnapshot(current),
      after: storeSnapshot(after),
      ...auditContext(context),
    });
    return after;
  }

  async deactivate(
    actor: AuditActor,
    storeId: string,
    context: StoreRequestContext = {},
  ): Promise<StoreDto> {
    assertAdmin(actor);
    const id = normalizeId(storeId, 'ID toko');
    const before = await this.repository.findById(id);
    if (!before) throw notFound();
    const current = storeDto(before);
    if (!current.isActive) return current;
    const updated = await this.repository.update(id, { isActive: false });
    if (!updated) throw notFound();
    const after = storeDto(updated);
    await this.audit.record({
      actor,
      action: 'store.deactivate',
      entityType: 'store',
      entityId: id,
      before: storeSnapshot(current),
      after: storeSnapshot(after),
      ...auditContext(context),
    });
    return after;
  }

  async listAssignments(
    actor: AuditActor,
    storeId: string,
  ): Promise<readonly EmployeeStoreAssignmentDto[]> {
    assertAdmin(actor);
    const id = normalizeId(storeId, 'ID toko');
    if (!(await this.repository.findById(id))) throw notFound();
    return (await this.repository.listAssignments(id)).map(assignmentDto);
  }

  async assignEmployee(
    actor: AuditActor,
    storeId: string,
    employeeId: string,
    context: StoreRequestContext = {},
  ): Promise<EmployeeStoreAssignmentDto> {
    assertAdmin(actor);
    const store = normalizeId(storeId, 'ID toko');
    const employee = normalizeId(employeeId, 'ID karyawan');
    if (!(await this.repository.findById(store))) throw notFound();
    if (!(await this.repository.findEmployeeById(employee))) throw notFound('employee');
    const result = await this.repository.createAssignment({
      storeId: store,
      employeeId: employee,
      assignedByUserAccountId: actor.userAccountId,
    });
    const after = assignmentDto(result.assignment);
    if (result.created) {
      await this.audit.record({
        actor,
        action: 'store.employee_assigned',
        entityType: 'employee_store',
        entityId: `${store}:${employee}`,
        after: assignmentSnapshot(after),
        ...auditContext(context),
      });
    }
    return after;
  }

  async removeEmployee(
    actor: AuditActor,
    storeId: string,
    employeeId: string,
    context: StoreRequestContext = {},
  ): Promise<boolean> {
    assertAdmin(actor);
    const store = normalizeId(storeId, 'ID toko');
    const employee = normalizeId(employeeId, 'ID karyawan');
    if (!(await this.repository.findById(store))) throw notFound();
    if (!(await this.repository.findEmployeeById(employee))) throw notFound('employee');
    const result = await this.repository.deleteAssignment(store, employee);
    if (result.removed && result.before) {
      await this.audit.record({
        actor,
        action: 'store.employee_unassigned',
        entityType: 'employee_store',
        entityId: `${store}:${employee}`,
        before: assignmentSnapshot(assignmentDto(result.before)),
        ...auditContext(context),
      });
    }
    return result.removed;
  }
}
