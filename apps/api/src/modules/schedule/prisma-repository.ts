import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { assertBusinessDate, assertValidClockTime } from '../time/index.js';
import {
  assertValidShiftTimePair,
  shiftAssignmentsConflict,
  type AssignmentListFilter,
  type HolidayCreateData,
  type HolidayListFilter,
  type HolidayRecord,
  type HolidayUpdateData,
  type ScheduleRepository,
  type ShiftAssignmentCreateData,
  type ShiftAssignmentRecord,
  type ShiftAssignmentUpdateData,
  type WorkShiftCreateData,
  type WorkShiftRecord,
  type WorkShiftUpdateData,
} from './index.js';

const workShiftSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  breakMinutes: true,
  lateToleranceMinutes: true,
  workDays: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const assignmentSelect = {
  id: true,
  employeeId: true,
  workShiftId: true,
  storeId: true,
  assignedByUserAccountId: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdAt: true,
  employee: { select: { id: true, nik: true, fullName: true, status: true } },
  workShift: { select: workShiftSelect },
} as const;

const holidaySelect = {
  id: true,
  storeId: true,
  holidayDate: true,
  description: true,
  createdAt: true,
} as const;

type WorkShiftRow = Prisma.WorkShiftGetPayload<{ select: typeof workShiftSelect }>;
type AssignmentRow = Prisma.ShiftAssignmentGetPayload<{ select: typeof assignmentSelect }>;
type HolidayRow = Prisma.HolidayGetPayload<{ select: typeof holidaySelect }>;
type ScheduleTransaction = Prisma.TransactionClient;

const maxBusinessDate = '9999-12-31';

function dateToDatabase(value: string): Date {
  assertBusinessDate(value);
  return new Date(`${value}T00:00:00.000Z`);
}

function dateFromDatabase(value: Date): string {
  return assertBusinessDate(value.toISOString().slice(0, 10));
}

function timeToDatabase(value: string): Date {
  const normalized = value.length === 5 ? `${value}:00` : value;
  assertValidClockTime(normalized);
  const [hour, minute, second] = normalized.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, hour, minute, second));
}

function timeFromDatabase(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new RangeError('PostgreSQL returned invalid TIME.');
  return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
}

function mapWorkShift(row: WorkShiftRow): WorkShiftRecord {
  return {
    id: row.id,
    name: row.name,
    startTime: timeFromDatabase(row.startTime),
    endTime: timeFromDatabase(row.endTime),
    breakMinutes: row.breakMinutes,
    lateToleranceMinutes: row.lateToleranceMinutes,
    workDays: row.workDays,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAssignment(row: AssignmentRow): ShiftAssignmentRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    workShiftId: row.workShiftId,
    storeId: row.storeId,
    assignedByUserAccountId: row.assignedByUserAccountId,
    effectiveFrom: dateFromDatabase(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : dateFromDatabase(row.effectiveTo),
    createdAt: row.createdAt,
    employee: row.employee,
    workShift: mapWorkShift(row.workShift),
  };
}

function mapHoliday(row: HolidayRow): HolidayRecord {
  return {
    id: row.id,
    storeId: row.storeId,
    holidayDate: dateFromDatabase(row.holidayDate),
    description: row.description,
    createdAt: row.createdAt,
  };
}

function scheduleConflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function notFound(code: 'SHIFT_NOT_FOUND' | 'EMPLOYEE_NOT_FOUND' | 'STORE_NOT_FOUND'): AppError {
  if (code === 'SHIFT_NOT_FOUND') return new AppError(404, code, 'Shift tidak ditemukan.');
  if (code === 'EMPLOYEE_NOT_FOUND') return new AppError(404, code, 'Karyawan tidak ditemukan.');
  return new AppError(404, code, 'Toko tidak ditemukan.');
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function uniqueConflict(): AppError {
  return scheduleConflict(
    'HOLIDAY_DATE_CONFLICT',
    'Hari libur dengan cakupan dan tanggal tersebut sudah terdaftar.',
  );
}

function assignmentConflict(): AppError {
  return scheduleConflict(
    'SHIFT_ASSIGNMENT_CONFLICT',
    'Rentang tanggal bertabrakan dengan penugasan shift karyawan pada cakupan toko yang sama.',
  );
}

function assignmentHistoryConflict(): AppError {
  return scheduleConflict(
    'SHIFT_ASSIGNMENT_HAS_ATTENDANCE',
    'Perubahan ini akan mengubah cakupan penugasan yang sudah dirujuk absensi historis.',
  );
}

function shiftHasAttendanceConflict(): AppError {
  return scheduleConflict(
    'SHIFT_HAS_ATTENDANCE',
    'Aturan shift yang sudah digunakan absensi tidak dapat diubah; buat shift baru untuk perubahan jadwal.',
  );
}

function createWorkShiftData(data: WorkShiftCreateData): Prisma.WorkShiftCreateInput {
  return {
    name: data.name,
    startTime: timeToDatabase(data.startTime),
    endTime: timeToDatabase(data.endTime),
    ...(data.breakMinutes === undefined ? {} : { breakMinutes: data.breakMinutes }),
    ...(data.lateToleranceMinutes === undefined
      ? {}
      : { lateToleranceMinutes: data.lateToleranceMinutes }),
    ...(data.workDays === undefined ? {} : { workDays: [...data.workDays] }),
    ...(data.isActive === undefined ? {} : { isActive: data.isActive }),
  };
}

function updateWorkShiftData(data: WorkShiftUpdateData): Prisma.WorkShiftUpdateInput {
  return {
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.startTime === undefined ? {} : { startTime: timeToDatabase(data.startTime) }),
    ...(data.endTime === undefined ? {} : { endTime: timeToDatabase(data.endTime) }),
    ...(data.breakMinutes === undefined ? {} : { breakMinutes: data.breakMinutes }),
    ...(data.lateToleranceMinutes === undefined
      ? {}
      : { lateToleranceMinutes: data.lateToleranceMinutes }),
    ...(data.workDays === undefined ? {} : { workDays: [...data.workDays] }),
    ...(data.isActive === undefined ? {} : { isActive: data.isActive }),
  };
}

function assignmentScopeWhere(storeId: string | null): Prisma.ShiftAssignmentWhereInput {
  return storeId === null ? {} : { OR: [{ storeId: null }, { storeId }] };
}

function overlapWhere(
  employeeId: string,
  storeId: string | null,
  effectiveFrom: string,
  effectiveTo: string | null,
  exceptId?: string,
): Prisma.ShiftAssignmentWhereInput {
  return {
    employeeId,
    ...assignmentScopeWhere(storeId),
    effectiveFrom: { lte: dateToDatabase(effectiveTo ?? maxBusinessDate) },
    AND: [
      {
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateToDatabase(effectiveFrom) } }],
      },
      ...(exceptId === undefined ? [] : [{ id: { not: exceptId } }]),
    ],
  };
}

function isScheduleFieldChange(data: WorkShiftUpdateData): boolean {
  return (
    data.startTime !== undefined ||
    data.endTime !== undefined ||
    data.breakMinutes !== undefined ||
    data.lateToleranceMinutes !== undefined ||
    data.workDays !== undefined
  );
}

async function lockShiftKeyShare(tx: ScheduleTransaction, shiftId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    SELECT id FROM work_shifts WHERE id = ${shiftId}::uuid FOR KEY SHARE
  `);
  return rows.length > 0;
}

async function lockShiftForUpdate(tx: ScheduleTransaction, shiftId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    SELECT id FROM work_shifts WHERE id = ${shiftId}::uuid FOR UPDATE
  `);
  return rows.length > 0;
}

async function lockEmployeeAssignments(tx: ScheduleTransaction, employeeId: string): Promise<void> {
  await tx.$queryRaw<readonly { pg_advisory_xact_lock: null }[]>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}::text, 0))
  `);
}

async function lockAssignmentsForShift(tx: ScheduleTransaction, shiftId: string): Promise<void> {
  await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    SELECT id FROM shift_assignments WHERE work_shift_id = ${shiftId}::uuid FOR UPDATE
  `);
}

function assignmentWhereForDate(
  employeeId: string,
  storeId: string | null,
  businessDate: string,
): Prisma.ShiftAssignmentWhereInput {
  return {
    employeeId,
    ...(storeId === null ? { storeId: null } : { OR: [{ storeId: null }, { storeId }] }),
    effectiveFrom: { lte: dateToDatabase(businessDate) },
    AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateToDatabase(businessDate) } }] }],
  };
}

export class PrismaScheduleRepository implements ScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listShifts(): Promise<readonly WorkShiftRecord[]> {
    const rows = await this.prisma.workShift.findMany({
      select: workShiftSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapWorkShift);
  }

  async findShift(id: string): Promise<WorkShiftRecord | null> {
    const row = await this.prisma.workShift.findUnique({ where: { id }, select: workShiftSelect });
    return row ? mapWorkShift(row) : null;
  }

  async createShift(data: WorkShiftCreateData): Promise<WorkShiftRecord> {
    const row = await this.prisma.workShift.create({
      data: createWorkShiftData(data),
      select: workShiftSelect,
    });
    return mapWorkShift(row);
  }

  async updateShift(id: string, data: WorkShiftUpdateData): Promise<WorkShiftRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockShiftForUpdate(tx, id))) return null;
      const before = await tx.workShift.findUnique({ where: { id }, select: workShiftSelect });
      if (!before) return null;
      const nextStart = data.startTime ?? timeFromDatabase(before.startTime);
      const nextEnd = data.endTime ?? timeFromDatabase(before.endTime);
      assertValidShiftTimePair(nextStart, nextEnd);
      if (isScheduleFieldChange(data)) {
        await lockAssignmentsForShift(tx, id);
        const attendanceCount = await tx.attendance.count({
          where: { shiftAssignment: { workShiftId: id } },
        });
        if (attendanceCount > 0) throw shiftHasAttendanceConflict();
      }
      const updated = await tx.workShift.update({
        where: { id },
        data: updateWorkShiftData(data),
        select: workShiftSelect,
      });
      return mapWorkShift(updated);
    });
  }

  async deactivateShift(
    id: string,
    effectiveThrough: string,
  ): Promise<Readonly<{ before: WorkShiftRecord; after: WorkShiftRecord }> | null> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockShiftForUpdate(tx, id))) return null;
      const beforeRow = await tx.workShift.findUnique({ where: { id }, select: workShiftSelect });
      if (!beforeRow) return null;
      const before = mapWorkShift(beforeRow);
      if (!before.isActive) return { before, after: before };
      const activeAssignments = await tx.shiftAssignment.count({
        where: {
          workShiftId: id,
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateToDatabase(effectiveThrough) } }],
        },
      });
      if (activeAssignments > 0) {
        throw scheduleConflict(
          'SHIFT_HAS_ACTIVE_ASSIGNMENTS',
          'Akhiri atau pindahkan semua penugasan yang berlaku mulai tanggal ini sebelum menonaktifkan shift.',
        );
      }
      const after = mapWorkShift(
        await tx.workShift.update({
          where: { id },
          data: { isActive: false },
          select: workShiftSelect,
        }),
      );
      return { before, after };
    });
  }

  async listAssignments(filter: AssignmentListFilter): Promise<readonly ShiftAssignmentRecord[]> {
    const where: Prisma.ShiftAssignmentWhereInput = {
      ...(filter.employeeId === undefined ? {} : { employeeId: filter.employeeId }),
      ...(filter.storeId === undefined
        ? {}
        : filter.storeId === null
          ? { storeId: null }
          : { storeId: filter.storeId }),
      ...(filter.businessDate === undefined
        ? {}
        : {
            effectiveFrom: { lte: dateToDatabase(filter.businessDate) },
            AND: [
              {
                OR: [
                  { effectiveTo: null },
                  { effectiveTo: { gte: dateToDatabase(filter.businessDate) } },
                ],
              },
            ],
          }),
    };
    const rows = await this.prisma.shiftAssignment.findMany({
      where,
      select: assignmentSelect,
      orderBy: [{ effectiveFrom: 'desc' }, { employeeId: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapAssignment);
  }

  async findAssignment(id: string): Promise<ShiftAssignmentRecord | null> {
    const row = await this.prisma.shiftAssignment.findUnique({
      where: { id },
      select: assignmentSelect,
    });
    return row ? mapAssignment(row) : null;
  }

  async createAssignment(
    data: ShiftAssignmentCreateData & Readonly<{ assignedByUserAccountId: string }>,
  ): Promise<ShiftAssignmentRecord> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockShiftKeyShare(tx, data.workShiftId))) throw notFound('SHIFT_NOT_FOUND');
      await lockEmployeeAssignments(tx, data.employeeId);
      const [employee, workShift] = await Promise.all([
        tx.employee.findUnique({ where: { id: data.employeeId }, select: { id: true } }),
        tx.workShift.findUnique({ where: { id: data.workShiftId }, select: { isActive: true } }),
      ]);
      if (!employee) throw notFound('EMPLOYEE_NOT_FOUND');
      if (!workShift) throw notFound('SHIFT_NOT_FOUND');
      if (!workShift.isActive) {
        throw scheduleConflict('SHIFT_INACTIVE', 'Penugasan baru hanya dapat memakai shift aktif.');
      }
      if (data.storeId !== undefined && data.storeId !== null) {
        const store = await tx.store.findUnique({
          where: { id: data.storeId },
          select: { id: true, isActive: true },
        });
        if (!store) throw notFound('STORE_NOT_FOUND');
        if (!store.isActive) {
          throw scheduleConflict(
            'STORE_INACTIVE',
            'Penugasan shift baru memerlukan toko yang aktif.',
          );
        }
        const employeeStore = await tx.employeeStore.findUnique({
          where: { employeeId_storeId: { employeeId: data.employeeId, storeId: data.storeId } },
          select: { employeeId: true },
        });
        if (!employeeStore) {
          throw scheduleConflict(
            'EMPLOYEE_NOT_ASSIGNED_TO_STORE',
            'Karyawan harus ditugaskan ke toko sebelum mendapat shift khusus toko tersebut.',
          );
        }
      }
      const candidates = await tx.shiftAssignment.findMany({
        where: overlapWhere(
          data.employeeId,
          data.storeId ?? null,
          data.effectiveFrom,
          data.effectiveTo ?? null,
        ),
        select: {
          id: true,
          employeeId: true,
          storeId: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
      if (
        candidates.some((row) =>
          shiftAssignmentsConflict(
            {
              employeeId: data.employeeId,
              storeId: data.storeId ?? null,
              effectiveFrom: data.effectiveFrom,
              effectiveTo: data.effectiveTo ?? null,
            },
            {
              employeeId: row.employeeId,
              storeId: row.storeId,
              effectiveFrom: dateFromDatabase(row.effectiveFrom),
              effectiveTo: row.effectiveTo === null ? null : dateFromDatabase(row.effectiveTo),
            },
          ),
        )
      ) {
        throw assignmentConflict();
      }
      const row = await tx.shiftAssignment.create({
        data: {
          employeeId: data.employeeId,
          workShiftId: data.workShiftId,
          storeId: data.storeId ?? null,
          assignedByUserAccountId: data.assignedByUserAccountId,
          effectiveFrom: dateToDatabase(data.effectiveFrom),
          effectiveTo: data.effectiveTo == null ? null : dateToDatabase(data.effectiveTo),
        },
        select: assignmentSelect,
      });
      return mapAssignment(row);
    });
  }

  async updateAssignment(
    id: string,
    data: ShiftAssignmentUpdateData,
  ): Promise<Readonly<{ before: ShiftAssignmentRecord; after: ShiftAssignmentRecord }> | null> {
    return this.prisma.$transaction(async (tx) => {
      let initial = await tx.shiftAssignment.findUnique({
        where: { id },
        select: { employeeId: true, workShiftId: true },
      });
      if (!initial) return null;
      const targetShiftId = data.workShiftId ?? initial.workShiftId;
      const initiallyLockedShiftIds = new Set([initial.workShiftId, targetShiftId]);
      for (const shiftId of [...initiallyLockedShiftIds].sort()) {
        if (!(await lockShiftKeyShare(tx, shiftId))) throw notFound('SHIFT_NOT_FOUND');
      }
      await lockEmployeeAssignments(tx, initial.employeeId);
      initial = await tx.shiftAssignment.findUnique({
        where: { id },
        select: { employeeId: true, workShiftId: true },
      });
      if (!initial) return null;
      if (!initiallyLockedShiftIds.has(initial.workShiftId)) {
        if (!(await lockShiftKeyShare(tx, initial.workShiftId))) throw notFound('SHIFT_NOT_FOUND');
      }
      await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT id FROM shift_assignments WHERE id = ${id}::uuid FOR UPDATE
      `);
      const currentRow = await tx.shiftAssignment.findUnique({
        where: { id },
        select: assignmentSelect,
      });
      if (!currentRow) return null;
      const before = mapAssignment(currentRow);
      const afterEffectiveFrom = data.effectiveFrom ?? before.effectiveFrom;
      const afterEffectiveTo =
        data.effectiveTo === undefined ? before.effectiveTo : data.effectiveTo;
      if (afterEffectiveTo !== null && afterEffectiveTo < afterEffectiveFrom) {
        throw new AppError(
          400,
          'INVALID_SCHEDULE_INPUT',
          'effectiveTo tidak boleh lebih awal dari effectiveFrom.',
        );
      }
      const afterStoreId = data.storeId === undefined ? before.storeId : data.storeId;
      const afterWorkShiftId = data.workShiftId ?? before.workShiftId;
      if (data.workShiftId !== undefined && data.workShiftId !== before.workShiftId) {
        const targetShift = await tx.workShift.findUnique({
          where: { id: data.workShiftId },
          select: { isActive: true },
        });
        if (!targetShift) throw notFound('SHIFT_NOT_FOUND');
        if (!targetShift.isActive) {
          throw scheduleConflict(
            'SHIFT_INACTIVE',
            'Penugasan baru hanya dapat memakai shift aktif.',
          );
        }
      }
      const attendanceRows = await tx.attendance.findMany({
        where: { shiftAssignmentId: id },
        select: { workDate: true },
      });
      if (attendanceRows.length > 0) {
        const historicDates = attendanceRows.map((row) => dateFromDatabase(row.workDate));
        const earliestAttendance = historicDates.reduce((earliest, value) =>
          value < earliest ? value : earliest,
        );
        const latestAttendance = historicDates.reduce((latest, value) =>
          value > latest ? value : latest,
        );
        if (
          afterWorkShiftId !== before.workShiftId ||
          afterStoreId !== before.storeId ||
          afterEffectiveFrom > earliestAttendance ||
          (afterEffectiveTo !== null && afterEffectiveTo < latestAttendance)
        ) {
          throw assignmentHistoryConflict();
        }
      }
      const candidates = await tx.shiftAssignment.findMany({
        where: overlapWhere(
          before.employeeId,
          afterStoreId,
          afterEffectiveFrom,
          afterEffectiveTo,
          id,
        ),
        select: {
          id: true,
          employeeId: true,
          storeId: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
      if (
        candidates.some((row) =>
          shiftAssignmentsConflict(
            {
              employeeId: before.employeeId,
              storeId: afterStoreId,
              effectiveFrom: afterEffectiveFrom,
              effectiveTo: afterEffectiveTo,
            },
            {
              employeeId: row.employeeId,
              storeId: row.storeId,
              effectiveFrom: dateFromDatabase(row.effectiveFrom),
              effectiveTo: row.effectiveTo === null ? null : dateFromDatabase(row.effectiveTo),
            },
          ),
        )
      ) {
        throw assignmentConflict();
      }
      if (afterStoreId !== null && afterStoreId !== before.storeId) {
        const store = await tx.store.findUnique({
          where: { id: afterStoreId },
          select: { id: true, isActive: true },
        });
        if (!store) throw notFound('STORE_NOT_FOUND');
        if (!store.isActive) {
          throw scheduleConflict(
            'STORE_INACTIVE',
            'Penugasan shift baru memerlukan toko yang aktif.',
          );
        }
        const employeeStore = await tx.employeeStore.findUnique({
          where: { employeeId_storeId: { employeeId: before.employeeId, storeId: afterStoreId } },
          select: { employeeId: true },
        });
        if (!employeeStore) {
          throw scheduleConflict(
            'EMPLOYEE_NOT_ASSIGNED_TO_STORE',
            'Karyawan harus ditugaskan ke toko sebelum mendapat shift khusus toko tersebut.',
          );
        }
      }
      const updatedRow = await tx.shiftAssignment.update({
        where: { id },
        data: {
          ...(data.workShiftId === undefined ? {} : { workShiftId: data.workShiftId }),
          ...(data.storeId === undefined ? {} : { storeId: data.storeId }),
          ...(data.effectiveFrom === undefined
            ? {}
            : { effectiveFrom: dateToDatabase(data.effectiveFrom) }),
          ...(data.effectiveTo === undefined
            ? {}
            : { effectiveTo: data.effectiveTo === null ? null : dateToDatabase(data.effectiveTo) }),
        },
        select: assignmentSelect,
      });
      return { before, after: mapAssignment(updatedRow) };
    });
  }

  async listEffectiveAssignments(
    employeeId: string,
    storeId: string | null,
    businessDate: string,
  ): Promise<readonly ShiftAssignmentRecord[]> {
    const rows = await this.prisma.shiftAssignment.findMany({
      where: assignmentWhereForDate(employeeId, storeId, businessDate),
      select: assignmentSelect,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
    });
    return rows.map(mapAssignment);
  }

  async listHolidays(filter: HolidayListFilter): Promise<readonly HolidayRecord[]> {
    const rows = await this.prisma.holiday.findMany({
      where: {
        ...(filter.storeId === undefined ? {} : { storeId: filter.storeId }),
        ...(filter.from === undefined || filter.to === undefined
          ? {
              ...(filter.from === undefined
                ? {}
                : { holidayDate: { gte: dateToDatabase(filter.from) } }),
              ...(filter.to === undefined
                ? {}
                : { holidayDate: { lte: dateToDatabase(filter.to) } }),
            }
          : {
              holidayDate: {
                gte: dateToDatabase(filter.from),
                lte: dateToDatabase(filter.to),
              },
            }),
      },
      select: holidaySelect,
      orderBy: [{ holidayDate: 'asc' }, { storeId: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapHoliday);
  }

  async findHoliday(id: string): Promise<HolidayRecord | null> {
    const row = await this.prisma.holiday.findUnique({ where: { id }, select: holidaySelect });
    return row ? mapHoliday(row) : null;
  }

  async createHoliday(data: HolidayCreateData): Promise<HolidayRecord> {
    try {
      const row = await this.prisma.holiday.create({
        data: {
          storeId: data.storeId ?? null,
          holidayDate: dateToDatabase(data.holidayDate),
          description: data.description,
        },
        select: holidaySelect,
      });
      return mapHoliday(row);
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2002')) throw uniqueConflict();
      if (isPrismaCode(error, 'P2003')) throw notFound('STORE_NOT_FOUND');
      throw error;
    }
  }

  async updateHoliday(id: string, data: HolidayUpdateData): Promise<HolidayRecord | null> {
    try {
      const row = await this.prisma.holiday.update({
        where: { id },
        data: {
          ...(data.storeId === undefined ? {} : { storeId: data.storeId }),
          ...(data.holidayDate === undefined
            ? {}
            : { holidayDate: dateToDatabase(data.holidayDate) }),
          ...(data.description === undefined ? {} : { description: data.description }),
        },
        select: holidaySelect,
      });
      return mapHoliday(row);
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2025')) return null;
      if (isPrismaCode(error, 'P2002')) throw uniqueConflict();
      if (isPrismaCode(error, 'P2003')) throw notFound('STORE_NOT_FOUND');
      throw error;
    }
  }

  async deleteHoliday(id: string): Promise<HolidayRecord | null> {
    const before = await this.findHoliday(id);
    if (!before) return null;
    try {
      await this.prisma.holiday.delete({ where: { id } });
      return before;
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2025')) return null;
      throw error;
    }
  }
}
