import { EmployeeStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';

export type EmployeeRecord = Readonly<{
  id: string;
  nik: string;
  fullName: string;
  position: string | null;
  status: EmployeeStatus;
  employmentDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type EmployeeDto = EmployeeRecord;

export type CreateEmployeeInput = Readonly<{
  nik: string;
  fullName: string;
  position?: string | null;
  status?: EmployeeStatus;
  employmentDate?: string | Date | null;
}>;

export type UpdateEmployeeInput = Readonly<{
  nik?: string;
  fullName?: string;
  position?: string | null;
  status?: EmployeeStatus;
  employmentDate?: string | Date | null;
}>;

export type EmployeeRequestContext = Readonly<{
  clientIp?: string;
  requestId?: string;
}>;

export type EmployeeCreateData = Omit<EmployeeRecord, 'id' | 'createdAt' | 'updatedAt'>;

type EmployeeUpdateData = {
  -readonly [Field in keyof EmployeeCreateData]?: EmployeeCreateData[Field];
};

export interface EmployeeRepository {
  list(): Promise<readonly EmployeeRecord[]>;
  findById(id: string): Promise<EmployeeRecord | null>;
  findByNik(nik: string): Promise<EmployeeRecord | null>;
  findAccountByUsername(username: string): Promise<Readonly<{ id: string }> | null>;
  create(data: EmployeeCreateData): Promise<EmployeeRecord>;
  update(id: string, data: EmployeeUpdateData): Promise<EmployeeRecord | null>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function invalidInput(message: string): AppError {
  return new AppError(400, 'INVALID_EMPLOYEE_INPUT', message);
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola data karyawan.');
  }
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput('ID karyawan tidak valid.');
  }
  return value;
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

function normalizeStatus(value: unknown): EmployeeStatus {
  if (
    typeof value !== 'string' ||
    !Object.values(EmployeeStatus).includes(value as EmployeeStatus)
  ) {
    throw invalidInput('Status karyawan tidak valid.');
  }
  return value as EmployeeStatus;
}

function normalizeEmploymentDate(value: unknown): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidInput('Tanggal mulai bekerja tidak valid.');
    return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw invalidInput('Tanggal mulai bekerja harus menggunakan format YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalidInput('Tanggal mulai bekerja tidak valid.');
  }
  return parsed;
}

function snapshot(employee: EmployeeRecord): Record<string, unknown> {
  return {
    id: employee.id,
    nik: employee.nik,
    fullName: employee.fullName,
    position: employee.position,
    status: employee.status,
    employmentDate: employee.employmentDate?.toISOString().slice(0, 10) ?? null,
  };
}

function notFound(): AppError {
  return new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Data karyawan tidak ditemukan.');
}

function duplicateNik(): AppError {
  return new AppError(409, 'EMPLOYEE_NIK_CONFLICT', 'NIK sudah digunakan karyawan lain.');
}

function nikUsernameConflict(): AppError {
  return new AppError(
    409,
    'EMPLOYEE_NIK_USERNAME_CONFLICT',
    'NIK sudah digunakan sebagai username akun.',
  );
}

function auditContext(context: EmployeeRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

export class EmployeeService {
  constructor(
    private readonly repository: EmployeeRepository,
    private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  async list(actor: AuditActor): Promise<readonly EmployeeDto[]> {
    assertAdmin(actor);
    return this.repository.list();
  }

  async get(actor: AuditActor, employeeId: string): Promise<EmployeeDto> {
    assertAdmin(actor);
    const row = await this.repository.findById(normalizeId(employeeId));
    if (!row) throw notFound();
    return row;
  }

  async create(
    actor: AuditActor,
    input: CreateEmployeeInput,
    context: EmployeeRequestContext = {},
  ): Promise<EmployeeDto> {
    assertAdmin(actor);
    const data: EmployeeCreateData = {
      nik: normalizeText(input.nik, 'NIK', 64),
      fullName: normalizeText(input.fullName, 'Nama lengkap', 150),
      position:
        input.position === undefined ? null : normalizeOptionalText(input.position, 'Jabatan', 100),
      status: input.status === undefined ? EmployeeStatus.ACTIVE : normalizeStatus(input.status),
      employmentDate:
        input.employmentDate === undefined ? null : normalizeEmploymentDate(input.employmentDate),
    };
    if (await this.repository.findByNik(data.nik)) throw duplicateNik();
    if (await this.repository.findAccountByUsername(data.nik)) throw nikUsernameConflict();

    const created = await this.repository.create(data);
    await this.audit.record({
      actor,
      action: 'employee.create',
      entityType: 'employee',
      entityId: created.id,
      after: snapshot(created),
      ...auditContext(context),
    });
    return created;
  }

  async update(
    actor: AuditActor,
    employeeId: string,
    input: UpdateEmployeeInput,
    context: EmployeeRequestContext = {},
  ): Promise<EmployeeDto> {
    assertAdmin(actor);
    const id = normalizeId(employeeId);
    const before = await this.repository.findById(id);
    if (!before) throw notFound();

    const data: EmployeeUpdateData = {};
    if (input.nik !== undefined) data.nik = normalizeText(input.nik, 'NIK', 64);
    if (input.fullName !== undefined)
      data.fullName = normalizeText(input.fullName, 'Nama lengkap', 150);
    if (input.position !== undefined)
      data.position = normalizeOptionalText(input.position, 'Jabatan', 100);
    if (input.status !== undefined) data.status = normalizeStatus(input.status);
    if (input.employmentDate !== undefined)
      data.employmentDate = normalizeEmploymentDate(input.employmentDate);
    if (Object.keys(data).length === 0)
      throw invalidInput('Tidak ada data karyawan yang diperbarui.');

    if (data.nik !== undefined && data.nik !== before.nik) {
      const existing = await this.repository.findByNik(data.nik);
      if (existing && existing.id !== id) throw duplicateNik();
      if (await this.repository.findAccountByUsername(data.nik)) throw nikUsernameConflict();
    }

    const updated = await this.repository.update(id, data);
    if (!updated) throw notFound();
    await this.audit.record({
      actor,
      action: 'employee.update',
      entityType: 'employee',
      entityId: id,
      before: snapshot(before),
      after: snapshot(updated),
      ...auditContext(context),
    });
    return updated;
  }

  async deactivate(
    actor: AuditActor,
    employeeId: string,
    context: EmployeeRequestContext = {},
  ): Promise<EmployeeDto> {
    assertAdmin(actor);
    const id = normalizeId(employeeId);
    const before = await this.repository.findById(id);
    if (!before) throw notFound();
    if (before.status === EmployeeStatus.INACTIVE) return before;

    const updated = await this.repository.update(id, { status: EmployeeStatus.INACTIVE });
    if (!updated) throw notFound();
    await this.audit.record({
      actor,
      action: 'employee.deactivate',
      entityType: 'employee',
      entityId: id,
      before: snapshot(before),
      after: snapshot(updated),
      ...auditContext(context),
    });
    return updated;
  }
}
