import { EmployeeStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';
import {
  assertBusinessDate,
  assertValidClockTime,
  getBusinessDateAndWeekday,
  isWorkingDay,
  resolveShiftEnd,
} from '../time/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const VALID_WEEKDAYS = new Set([1, 2, 3, 4, 5, 6, 7]);

export type WorkShiftRecord = Readonly<{
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateToleranceMinutes: number;
  workDays: readonly number[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkShiftDto = Readonly<{
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateToleranceMinutes: number;
  workDays: readonly number[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type ShiftEmployee = Readonly<{
  id: string;
  nik: string;
  fullName: string;
  status: EmployeeStatus;
}>;

export type ShiftAssignmentRecord = Readonly<{
  id: string;
  employeeId: string;
  workShiftId: string;
  storeId: string | null;
  assignedByUserAccountId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: Date;
  employee: ShiftEmployee;
  workShift: WorkShiftRecord;
}>;

export type ShiftAssignmentDto = Readonly<{
  id: string;
  employeeId: string;
  workShiftId: string;
  storeId: string | null;
  assignedByUserAccountId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  employee: ShiftEmployee;
  workShift: WorkShiftDto;
}>;

export type HolidayRecord = Readonly<{
  id: string;
  storeId: string | null;
  holidayDate: string;
  description: string;
  createdAt: Date;
}>;

export type HolidayDto = Readonly<{
  id: string;
  storeId: string | null;
  holidayDate: string;
  description: string;
  createdAt: string;
}>;

export type WorkShiftCreateData = Readonly<{
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  lateToleranceMinutes?: number;
  workDays: readonly number[];
  isActive?: boolean;
}>;

export type WorkShiftUpdateData = Readonly<Partial<WorkShiftCreateData>>;

export type ShiftAssignmentCreateData = Readonly<{
  employeeId: string;
  workShiftId: string;
  storeId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
}>;

export type ShiftAssignmentUpdateData = Readonly<{
  workShiftId?: string;
  storeId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}>;

export type HolidayCreateData = Readonly<{
  storeId?: string | null;
  holidayDate: string;
  description: string;
}>;

export type HolidayUpdateData = Readonly<Partial<HolidayCreateData>>;

export type AssignmentListFilter = Readonly<{
  employeeId?: string;
  /** Omitted means all scopes; null means global-only; a UUID means that store only. */
  storeId?: string | null;
  businessDate?: string;
}>;

export type HolidayListFilter = Readonly<{
  from?: string;
  to?: string;
  /** Omitted means national and store holidays; null means national-only. */
  storeId?: string | null;
}>;

export type ScheduleRequestContext = Readonly<{ clientIp?: string; requestId?: string }>;

export interface ScheduleRepository {
  listShifts(): Promise<readonly WorkShiftRecord[]>;
  findShift(id: string): Promise<WorkShiftRecord | null>;
  createShift(data: WorkShiftCreateData): Promise<WorkShiftRecord>;
  updateShift(id: string, data: WorkShiftUpdateData): Promise<WorkShiftRecord | null>;
  deactivateShift(
    id: string,
    effectiveThrough: string,
  ): Promise<Readonly<{ before: WorkShiftRecord; after: WorkShiftRecord }> | null>;
  listAssignments(filter: AssignmentListFilter): Promise<readonly ShiftAssignmentRecord[]>;
  findAssignment(id: string): Promise<ShiftAssignmentRecord | null>;
  createAssignment(
    data: ShiftAssignmentCreateData & Readonly<{ assignedByUserAccountId: string }>,
  ): Promise<ShiftAssignmentRecord>;
  updateAssignment(
    id: string,
    data: ShiftAssignmentUpdateData,
  ): Promise<Readonly<{ before: ShiftAssignmentRecord; after: ShiftAssignmentRecord }> | null>;
  listEffectiveAssignments(
    employeeId: string,
    storeId: string | null,
    businessDate: string,
  ): Promise<readonly ShiftAssignmentRecord[]>;
  listHolidays(filter: HolidayListFilter): Promise<readonly HolidayRecord[]>;
  findHoliday(id: string): Promise<HolidayRecord | null>;
  createHoliday(data: HolidayCreateData): Promise<HolidayRecord>;
  updateHoliday(id: string, data: HolidayUpdateData): Promise<HolidayRecord | null>;
  deleteHoliday(id: string): Promise<HolidayRecord | null>;
}

export type EffectiveShift = Readonly<{
  assignment: ShiftAssignmentDto;
  shift: WorkShiftDto;
  businessDate: string;
  isWorkingDay: boolean;
  holidays: readonly HolidayDto[];
}>;

export function shiftAssignmentScopesOverlap(
  first: Readonly<{ employeeId: string; storeId: string | null }>,
  second: Readonly<{ employeeId: string; storeId: string | null }>,
): boolean {
  return (
    first.employeeId === second.employeeId &&
    (first.storeId === null || second.storeId === null || first.storeId === second.storeId)
  );
}

export function shiftAssignmentRangesOverlap(
  first: Readonly<{ effectiveFrom: string; effectiveTo: string | null }>,
  second: Readonly<{ effectiveFrom: string; effectiveTo: string | null }>,
): boolean {
  const firstEnd = first.effectiveTo ?? '9999-12-31';
  const secondEnd = second.effectiveTo ?? '9999-12-31';
  return first.effectiveFrom <= secondEnd && second.effectiveFrom <= firstEnd;
}

export function shiftAssignmentsConflict(
  first: Readonly<{
    employeeId: string;
    storeId: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>,
  second: Readonly<{
    employeeId: string;
    storeId: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>,
): boolean {
  return shiftAssignmentScopesOverlap(first, second) && shiftAssignmentRangesOverlap(first, second);
}

export function assertValidShiftTimePair(startTime: string, endTime: string): void {
  try {
    resolveShiftEnd('2000-01-01', startTime, endTime);
  } catch {
    throw invalidInput('Jam mulai dan selesai harus berupa jam WIB valid dan tidak boleh sama.');
  }
}

function invalidInput(message = 'Data jadwal atau hari libur tidak valid.'): AppError {
  return new AppError(400, 'INVALID_SCHEDULE_INPUT', message);
}

function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola jadwal.');
  }
}

function assertRecord(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidInput();
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidInput(`${field} berisi field yang tidak dikenal.`);
  }
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return value.toLowerCase();
}

function normalizeDate(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw invalidInput(`${field} harus berupa tanggal ISO YYYY-MM-DD.`);
  try {
    return assertBusinessDate(value);
  } catch {
    throw invalidInput(`${field} harus berupa tanggal kalender ISO yang valid.`);
  }
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidInput(`${field} wajib berupa teks.`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return normalized;
}

function normalizeNullableId(value: unknown, field: string): string | null {
  return value === null ? null : normalizeId(value, field);
}

function normalizeClockTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    throw invalidInput(`${field} harus memakai format HH:mm atau HH:mm:ss.`);
  }
  const [hour, minute, second = '00'] = value.split(':');
  const normalized = `${hour}:${minute}:${second}`;
  try {
    assertValidClockTime(normalized);
  } catch {
    throw invalidInput(`${field} berada di luar rentang jam dinding.`);
  }
  return normalized;
}

function normalizeNonNegativeInt(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > POSTGRES_INTEGER_MAX
  ) {
    throw invalidInput(
      `${field} harus berupa bilangan bulat non-negatif yang dapat disimpan database.`,
    );
  }
  return value;
}

function normalizeWorkDays(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidInput('Pilih minimal satu hari kerja dengan angka ISO 1 sampai 7.');
  }
  const days: number[] = [];
  const seen = new Set<number>();
  for (const day of value) {
    if (typeof day !== 'number' || !VALID_WEEKDAYS.has(day) || seen.has(day)) {
      throw invalidInput('Hari kerja harus unik dan memakai ISO 1 sampai 7 (Senin sampai Minggu).');
    }
    seen.add(day);
    days.push(day);
  }
  return days;
}

function normalizeShiftCreate(input: WorkShiftCreateData): WorkShiftCreateData {
  assertRecord(
    input,
    [
      'name',
      'startTime',
      'endTime',
      'breakMinutes',
      'lateToleranceMinutes',
      'workDays',
      'isActive',
    ],
    'Data shift',
  );
  const name = normalizeText(input.name, 'Nama shift');
  const startTime = normalizeClockTime(input.startTime, 'Jam mulai');
  const endTime = normalizeClockTime(input.endTime, 'Jam selesai');
  assertValidShiftTimePair(startTime, endTime);
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
    throw invalidInput('Status aktif shift harus berupa boolean.');
  }
  return {
    name,
    startTime,
    endTime,
    ...(input.breakMinutes === undefined
      ? {}
      : { breakMinutes: normalizeNonNegativeInt(input.breakMinutes, 'Durasi istirahat') }),
    ...(input.lateToleranceMinutes === undefined
      ? {}
      : {
          lateToleranceMinutes: normalizeNonNegativeInt(
            input.lateToleranceMinutes,
            'Toleransi keterlambatan',
          ),
        }),
    workDays: normalizeWorkDays(input.workDays),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  };
}

function normalizeShiftUpdate(input: WorkShiftUpdateData): WorkShiftUpdateData {
  assertRecord(
    input,
    [
      'name',
      'startTime',
      'endTime',
      'breakMinutes',
      'lateToleranceMinutes',
      'workDays',
      'isActive',
    ],
    'Data shift',
  );
  const data: {
    name?: string;
    startTime?: string;
    endTime?: string;
    breakMinutes?: number;
    lateToleranceMinutes?: number;
    workDays?: readonly number[];
    isActive?: boolean;
  } = {};
  if (input.name !== undefined) data.name = normalizeText(input.name, 'Nama shift');
  if (input.startTime !== undefined)
    data.startTime = normalizeClockTime(input.startTime, 'Jam mulai');
  if (input.endTime !== undefined) data.endTime = normalizeClockTime(input.endTime, 'Jam selesai');
  if (input.breakMinutes !== undefined) {
    data.breakMinutes = normalizeNonNegativeInt(input.breakMinutes, 'Durasi istirahat');
  }
  if (input.lateToleranceMinutes !== undefined) {
    data.lateToleranceMinutes = normalizeNonNegativeInt(
      input.lateToleranceMinutes,
      'Toleransi keterlambatan',
    );
  }
  if (input.workDays !== undefined) data.workDays = normalizeWorkDays(input.workDays);
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean')
      throw invalidInput('Status aktif shift harus berupa boolean.');
    data.isActive = input.isActive;
  }
  if (Object.keys(data).length === 0) throw invalidInput('Tidak ada data shift yang diperbarui.');
  return data;
}

function normalizeAssignmentCreate(input: ShiftAssignmentCreateData): ShiftAssignmentCreateData {
  assertRecord(
    input,
    ['employeeId', 'workShiftId', 'storeId', 'effectiveFrom', 'effectiveTo'],
    'Penugasan shift',
  );
  const effectiveFrom = normalizeDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo =
    input.effectiveTo === undefined || input.effectiveTo === null
      ? (input.effectiveTo ?? null)
      : normalizeDate(input.effectiveTo, 'effectiveTo');
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw invalidInput('effectiveTo tidak boleh lebih awal dari effectiveFrom.');
  }
  return {
    employeeId: normalizeId(input.employeeId, 'ID karyawan'),
    workShiftId: normalizeId(input.workShiftId, 'ID shift'),
    ...(input.storeId === undefined
      ? {}
      : { storeId: normalizeNullableId(input.storeId, 'ID toko') }),
    effectiveFrom,
    ...(input.effectiveTo === undefined ? {} : { effectiveTo }),
  };
}

function normalizeAssignmentUpdate(input: ShiftAssignmentUpdateData): ShiftAssignmentUpdateData {
  assertRecord(
    input,
    ['workShiftId', 'storeId', 'effectiveFrom', 'effectiveTo'],
    'Penugasan shift',
  );
  const data: {
    workShiftId?: string;
    storeId?: string | null;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  } = {};
  if (input.workShiftId !== undefined)
    data.workShiftId = normalizeId(input.workShiftId, 'ID shift');
  if (input.storeId !== undefined) data.storeId = normalizeNullableId(input.storeId, 'ID toko');
  if (input.effectiveFrom !== undefined) {
    data.effectiveFrom = normalizeDate(input.effectiveFrom, 'effectiveFrom');
  }
  if (input.effectiveTo !== undefined) {
    data.effectiveTo =
      input.effectiveTo === null ? null : normalizeDate(input.effectiveTo, 'effectiveTo');
  }
  if (Object.keys(data).length === 0)
    throw invalidInput('Tidak ada data penugasan yang diperbarui.');
  return data;
}

function normalizeHolidayCreate(input: HolidayCreateData): HolidayCreateData {
  assertRecord(input, ['storeId', 'holidayDate', 'description'], 'Hari libur');
  return {
    ...(input.storeId === undefined
      ? {}
      : { storeId: normalizeNullableId(input.storeId, 'ID toko') }),
    holidayDate: normalizeDate(input.holidayDate, 'holidayDate'),
    description: normalizeText(input.description, 'Keterangan hari libur'),
  };
}

function normalizeHolidayUpdate(input: HolidayUpdateData): HolidayUpdateData {
  assertRecord(input, ['storeId', 'holidayDate', 'description'], 'Hari libur');
  const data: { storeId?: string | null; holidayDate?: string; description?: string } = {};
  if (input.storeId !== undefined) data.storeId = normalizeNullableId(input.storeId, 'ID toko');
  if (input.holidayDate !== undefined)
    data.holidayDate = normalizeDate(input.holidayDate, 'holidayDate');
  if (input.description !== undefined) {
    data.description = normalizeText(input.description, 'Keterangan hari libur');
  }
  if (Object.keys(data).length === 0)
    throw invalidInput('Tidak ada data hari libur yang diperbarui.');
  return data;
}

function shiftDto(row: WorkShiftRecord): WorkShiftDto {
  return {
    id: row.id,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    lateToleranceMinutes: row.lateToleranceMinutes,
    workDays: [...row.workDays],
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assignmentDto(row: ShiftAssignmentRecord): ShiftAssignmentDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    workShiftId: row.workShiftId,
    storeId: row.storeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt.toISOString(),
    employee: row.employee,
    workShift: shiftDto(row.workShift),
  };
}

function holidayDto(row: HolidayRecord): HolidayDto {
  return {
    id: row.id,
    storeId: row.storeId,
    holidayDate: row.holidayDate,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

function shiftSnapshot(row: WorkShiftDto): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    lateToleranceMinutes: row.lateToleranceMinutes,
    workDays: row.workDays,
    isActive: row.isActive,
  };
}

function assignmentSnapshot(row: ShiftAssignmentDto): Record<string, unknown> {
  return {
    id: row.id,
    employeeId: row.employeeId,
    workShiftId: row.workShiftId,
    storeId: row.storeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

function holidaySnapshot(row: HolidayDto): Record<string, unknown> {
  return {
    id: row.id,
    storeId: row.storeId,
    holidayDate: row.holidayDate,
    description: row.description,
  };
}

function auditContext(context: ScheduleRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

function notFound(kind: 'shift' | 'assignment' | 'holiday'): AppError {
  if (kind === 'shift') return new AppError(404, 'SHIFT_NOT_FOUND', 'Shift tidak ditemukan.');
  if (kind === 'assignment') {
    return new AppError(404, 'SHIFT_ASSIGNMENT_NOT_FOUND', 'Penugasan shift tidak ditemukan.');
  }
  return new AppError(404, 'HOLIDAY_NOT_FOUND', 'Hari libur tidak ditemukan.');
}

function validateListFilterDateRange(from: string | undefined, to: string | undefined): void {
  if (from !== undefined && to !== undefined && to < from) {
    throw invalidInput('Rentang tanggal hari libur tidak valid.');
  }
}

export class ScheduleService {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listShifts(actor: AuditActor): Promise<readonly WorkShiftDto[]> {
    assertAdmin(actor);
    return (await this.repository.listShifts()).map(shiftDto);
  }

  async getShift(actor: AuditActor, shiftId: string): Promise<WorkShiftDto> {
    assertAdmin(actor);
    const row = await this.repository.findShift(normalizeId(shiftId, 'ID shift'));
    if (!row) throw notFound('shift');
    return shiftDto(row);
  }

  async createShift(
    actor: AuditActor,
    input: WorkShiftCreateData,
    context: ScheduleRequestContext = {},
  ): Promise<WorkShiftDto> {
    assertAdmin(actor);
    const created = shiftDto(await this.repository.createShift(normalizeShiftCreate(input)));
    await this.audit.record({
      actor,
      action: 'schedule.shift.create',
      entityType: 'work_shift',
      entityId: created.id,
      after: shiftSnapshot(created),
      ...auditContext(context),
    });
    return created;
  }

  async updateShift(
    actor: AuditActor,
    shiftId: string,
    input: WorkShiftUpdateData,
    context: ScheduleRequestContext = {},
  ): Promise<WorkShiftDto> {
    assertAdmin(actor);
    const id = normalizeId(shiftId, 'ID shift');
    const data = normalizeShiftUpdate(input);
    const before = await this.repository.findShift(id);
    if (!before) throw notFound('shift');
    assertValidShiftTimePair(data.startTime ?? before.startTime, data.endTime ?? before.endTime);
    const current = shiftDto(before);
    const changed = Object.entries(data).some(
      ([key, value]) =>
        JSON.stringify(current[key as keyof WorkShiftDto]) !== JSON.stringify(value),
    );
    if (!changed) return current;
    const updated = await this.repository.updateShift(id, data);
    if (!updated) throw notFound('shift');
    const after = shiftDto(updated);
    await this.audit.record({
      actor,
      action: 'schedule.shift.update',
      entityType: 'work_shift',
      entityId: id,
      before: shiftSnapshot(current),
      after: shiftSnapshot(after),
      ...auditContext(context),
    });
    return after;
  }

  async deactivateShift(
    actor: AuditActor,
    shiftId: string,
    context: ScheduleRequestContext = {},
  ): Promise<WorkShiftDto> {
    assertAdmin(actor);
    const id = normalizeId(shiftId, 'ID shift');
    let businessDate: string;
    try {
      businessDate = assertBusinessDate(getBusinessDateAndWeekday(this.now()).businessDate);
    } catch {
      throw new AppError(503, 'INTERNAL_SERVER_ERROR', 'Waktu server tidak tersedia.');
    }
    const result = await this.repository.deactivateShift(id, businessDate);
    if (!result) throw notFound('shift');
    if (result.before.isActive) {
      await this.audit.record({
        actor,
        action: 'schedule.shift.deactivate',
        entityType: 'work_shift',
        entityId: id,
        before: shiftSnapshot(shiftDto(result.before)),
        after: shiftSnapshot(shiftDto(result.after)),
        ...auditContext(context),
      });
    }
    return shiftDto(result.after);
  }

  async listAssignments(
    actor: AuditActor,
    filter: AssignmentListFilter = {},
  ): Promise<readonly ShiftAssignmentDto[]> {
    assertAdmin(actor);
    const normalized: AssignmentListFilter = {
      ...(filter.employeeId === undefined
        ? {}
        : { employeeId: normalizeId(filter.employeeId, 'ID karyawan') }),
      ...(filter.storeId === undefined
        ? {}
        : { storeId: filter.storeId === null ? null : normalizeId(filter.storeId, 'ID toko') }),
      ...(filter.businessDate === undefined
        ? {}
        : { businessDate: normalizeDate(filter.businessDate, 'businessDate') }),
    };
    return (await this.repository.listAssignments(normalized)).map(assignmentDto);
  }

  async getAssignment(actor: AuditActor, assignmentId: string): Promise<ShiftAssignmentDto> {
    assertAdmin(actor);
    const row = await this.repository.findAssignment(normalizeId(assignmentId, 'ID penugasan'));
    if (!row) throw notFound('assignment');
    return assignmentDto(row);
  }

  async createAssignment(
    actor: AuditActor,
    input: ShiftAssignmentCreateData,
    context: ScheduleRequestContext = {},
  ): Promise<ShiftAssignmentDto> {
    assertAdmin(actor);
    const created = assignmentDto(
      await this.repository.createAssignment({
        ...normalizeAssignmentCreate(input),
        assignedByUserAccountId: actor.userAccountId,
      }),
    );
    await this.audit.record({
      actor,
      action: 'schedule.assignment.create',
      entityType: 'shift_assignment',
      entityId: created.id,
      after: assignmentSnapshot(created),
      ...auditContext(context),
    });
    return created;
  }

  async updateAssignment(
    actor: AuditActor,
    assignmentId: string,
    input: ShiftAssignmentUpdateData,
    context: ScheduleRequestContext = {},
  ): Promise<ShiftAssignmentDto> {
    assertAdmin(actor);
    const id = normalizeId(assignmentId, 'ID penugasan');
    const data = normalizeAssignmentUpdate(input);
    const result = await this.repository.updateAssignment(id, data);
    if (!result) throw notFound('assignment');
    const before = assignmentDto(result.before);
    const after = assignmentDto(result.after);
    if (JSON.stringify(assignmentSnapshot(before)) !== JSON.stringify(assignmentSnapshot(after))) {
      await this.audit.record({
        actor,
        action: 'schedule.assignment.update',
        entityType: 'shift_assignment',
        entityId: id,
        before: assignmentSnapshot(before),
        after: assignmentSnapshot(after),
        ...auditContext(context),
      });
    }
    return after;
  }

  async deactivateAssignment(
    actor: AuditActor,
    assignmentId: string,
    effectiveTo: string,
    context: ScheduleRequestContext = {},
  ): Promise<ShiftAssignmentDto> {
    assertAdmin(actor);
    const id = normalizeId(assignmentId, 'ID penugasan');
    const endDate = normalizeDate(effectiveTo, 'effectiveTo');
    const beforeRecord = await this.repository.findAssignment(id);
    if (!beforeRecord) throw notFound('assignment');
    if (endDate < beforeRecord.effectiveFrom) {
      throw invalidInput('effectiveTo tidak boleh lebih awal dari effectiveFrom.');
    }
    if (beforeRecord.effectiveTo !== null && endDate > beforeRecord.effectiveTo) {
      throw invalidInput(
        'Penonaktifan tidak boleh memperpanjang effectiveTo yang sudah ditetapkan.',
      );
    }
    const result = await this.repository.updateAssignment(id, { effectiveTo: endDate });
    if (!result) throw notFound('assignment');
    const before = assignmentDto(result.before);
    const after = assignmentDto(result.after);
    if (before.effectiveTo !== after.effectiveTo) {
      await this.audit.record({
        actor,
        action: 'schedule.assignment.deactivate',
        entityType: 'shift_assignment',
        entityId: id,
        before: assignmentSnapshot(before),
        after: assignmentSnapshot(after),
        ...auditContext(context),
      });
    }
    return after;
  }

  async resolveEffectiveShift(
    employeeId: string,
    storeId: string | null,
    businessDate: string,
  ): Promise<EffectiveShift | null> {
    const employee = normalizeId(employeeId, 'ID karyawan');
    const store = storeId === null ? null : normalizeId(storeId, 'ID toko');
    const date = normalizeDate(businessDate, 'businessDate');
    const assignments = await this.repository.listEffectiveAssignments(employee, store, date);
    if (assignments.length > 1) {
      throw conflict(
        'SHIFT_ASSIGNMENT_AMBIGUOUS',
        'Terdapat lebih dari satu penugasan shift efektif; minta Admin memperbaiki data jadwal.',
      );
    }
    const assignment = assignments[0];
    if (!assignment) return null;
    const holidayQueries = [
      this.repository.listHolidays({ from: date, to: date, storeId: null }),
      ...(store === null
        ? []
        : [this.repository.listHolidays({ from: date, to: date, storeId: store })]),
    ];
    const holidays = (await Promise.all(holidayQueries)).flat();
    const holidayDtos = holidays.map(holidayDto);
    return {
      assignment: assignmentDto(assignment),
      shift: shiftDto(assignment.workShift),
      businessDate: date,
      isWorkingDay: isWorkingDay(
        date,
        assignment.workShift.workDays,
        holidayDtos.map((holiday) => holiday.holidayDate),
      ),
      holidays: holidayDtos,
    };
  }

  async listHolidays(
    actor: AuditActor,
    filter: HolidayListFilter = {},
  ): Promise<readonly HolidayDto[]> {
    assertAdmin(actor);
    const normalized: HolidayListFilter = {
      ...(filter.from === undefined ? {} : { from: normalizeDate(filter.from, 'from') }),
      ...(filter.to === undefined ? {} : { to: normalizeDate(filter.to, 'to') }),
      ...(filter.storeId === undefined
        ? {}
        : { storeId: filter.storeId === null ? null : normalizeId(filter.storeId, 'ID toko') }),
    };
    validateListFilterDateRange(normalized.from, normalized.to);
    return (await this.repository.listHolidays(normalized)).map(holidayDto);
  }

  async getHoliday(actor: AuditActor, holidayId: string): Promise<HolidayDto> {
    assertAdmin(actor);
    const row = await this.repository.findHoliday(normalizeId(holidayId, 'ID hari libur'));
    if (!row) throw notFound('holiday');
    return holidayDto(row);
  }

  async createHoliday(
    actor: AuditActor,
    input: HolidayCreateData,
    context: ScheduleRequestContext = {},
  ): Promise<HolidayDto> {
    assertAdmin(actor);
    const created = holidayDto(await this.repository.createHoliday(normalizeHolidayCreate(input)));
    await this.audit.record({
      actor,
      action: 'schedule.holiday.create',
      entityType: 'holiday',
      entityId: created.id,
      after: holidaySnapshot(created),
      ...auditContext(context),
    });
    return created;
  }

  async updateHoliday(
    actor: AuditActor,
    holidayId: string,
    input: HolidayUpdateData,
    context: ScheduleRequestContext = {},
  ): Promise<HolidayDto> {
    assertAdmin(actor);
    const id = normalizeId(holidayId, 'ID hari libur');
    const data = normalizeHolidayUpdate(input);
    const before = await this.repository.findHoliday(id);
    if (!before) throw notFound('holiday');
    const current = holidayDto(before);
    const changed = Object.entries(data).some(
      ([key, value]) => current[key as keyof HolidayDto] !== value,
    );
    if (!changed) return current;
    const updated = await this.repository.updateHoliday(id, data);
    if (!updated) throw notFound('holiday');
    const after = holidayDto(updated);
    await this.audit.record({
      actor,
      action: 'schedule.holiday.update',
      entityType: 'holiday',
      entityId: id,
      before: holidaySnapshot(current),
      after: holidaySnapshot(after),
      ...auditContext(context),
    });
    return after;
  }

  async deleteHoliday(
    actor: AuditActor,
    holidayId: string,
    context: ScheduleRequestContext = {},
  ): Promise<void> {
    assertAdmin(actor);
    const id = normalizeId(holidayId, 'ID hari libur');
    const deleted = await this.repository.deleteHoliday(id);
    if (!deleted) throw notFound('holiday');
    const before = holidayDto(deleted);
    await this.audit.record({
      actor,
      action: 'schedule.holiday.delete',
      entityType: 'holiday',
      entityId: id,
      before: holidaySnapshot(before),
      ...auditContext(context),
    });
  }
}
