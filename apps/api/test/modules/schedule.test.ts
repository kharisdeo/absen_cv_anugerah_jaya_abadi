import { describe, expect, it, vi } from 'vitest';

import { EmployeeStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditActor, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  ScheduleService,
  shiftAssignmentsConflict,
  type HolidayRecord,
  type ScheduleRepository,
  type ShiftAssignmentRecord,
  type WorkShiftRecord,
} from '../../src/modules/schedule/index.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000002';
const STORE_ID = '00000000-0000-4000-8000-000000000003';
const SHIFT_ID = '00000000-0000-4000-8000-000000000004';
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000005';
const HOLIDAY_ID = '00000000-0000-4000-8000-000000000006';
const admin: AuditActor = { userAccountId: ADMIN_ID, role: UserRole.ADMIN };
const employeeActor: AuditActor = { userAccountId: EMPLOYEE_ID, role: UserRole.EMPLOYEE };

function makeShift(overrides: Partial<WorkShiftRecord> = {}): WorkShiftRecord {
  return {
    id: SHIFT_ID,
    name: 'Pagi',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    lateToleranceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<ShiftAssignmentRecord> = {}): ShiftAssignmentRecord {
  const workShift = overrides.workShift ?? makeShift();
  return {
    id: ASSIGNMENT_ID,
    employeeId: EMPLOYEE_ID,
    workShiftId: workShift.id,
    storeId: STORE_ID,
    assignedByUserAccountId: ADMIN_ID,
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    employee: {
      id: EMPLOYEE_ID,
      nik: 'AJ-001',
      fullName: 'Karyawan Satu',
      status: EmployeeStatus.ACTIVE,
    },
    workShift,
    ...overrides,
  };
}

function makeHoliday(overrides: Partial<HolidayRecord> = {}): HolidayRecord {
  return {
    id: HOLIDAY_ID,
    storeId: null,
    holidayDate: '2026-10-12',
    description: 'Hari libur nasional',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function repository(overrides: Partial<ScheduleRepository> = {}): ScheduleRepository {
  return new Proxy(overrides, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (value !== undefined) return value;
      return async () => {
        throw new Error(`Unexpected ScheduleRepository call: ${String(property)}`);
      };
    },
  }) as ScheduleRepository;
}

function harness(overrides: Partial<ScheduleRepository> = {}) {
  const events: RecordAuditEventInput[] = [];
  const service = new ScheduleService(repository(overrides), {
    async record(event) {
      events.push(event);
      return {} as never;
    },
  });
  return { service, events };
}

describe('ScheduleService', () => {
  it('is Admin-only and validates explicit non-empty ISO workdays and wall-clock ranges', async () => {
    const createShift = vi.fn(async () => makeShift());
    const { service } = harness({ createShift });

    await expect(service.listShifts(employeeActor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.createShift(admin, {
        name: 'Pagi',
        startTime: '08:00',
        endTime: '17:00',
        workDays: [],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
    await expect(
      service.createShift(admin, {
        name: 'Pagi',
        startTime: '08:00',
        endTime: '08:00',
        workDays: [1],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
    await expect(
      service.createShift(admin, {
        name: 'Pagi',
        startTime: '08:00',
        endTime: '17:00',
        workDays: [1, 1],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
    expect(createShift).not.toHaveBeenCalled();
  });

  it('normalizes clock input and audits successful shift creation', async () => {
    const createShift = vi.fn(async (data) =>
      makeShift({
        name: data.name,
        startTime: data.startTime,
        endTime: data.endTime,
        workDays: [...data.workDays],
      }),
    );
    const { service, events } = harness({ createShift });

    const result = await service.createShift(admin, {
      name: '  Pagi  ',
      startTime: '08:15',
      endTime: '17:00:30',
      workDays: [1, 2, 3, 4, 5],
    });

    expect(result).toMatchObject({
      name: 'Pagi',
      startTime: '08:15:00',
      endTime: '17:00:30',
      workDays: [1, 2, 3, 4, 5],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'schedule.shift.create',
      entityType: 'work_shift',
      after: { startTime: '08:15:00', workDays: [1, 2, 3, 4, 5] },
    });
  });

  it('audits shift, assignment, and holiday updates, deactivations, and deletion', async () => {
    const shiftBefore = makeShift();
    const shiftUpdated = makeShift({ name: 'Siang' });
    const assignmentCreated = makeAssignment();
    const assignmentUpdated = makeAssignment({ effectiveFrom: '2026-10-02' });
    const assignmentDeactivated = makeAssignment({
      effectiveFrom: '2026-10-02',
      effectiveTo: '2026-10-31',
    });
    const holidayCreated = makeHoliday({
      holidayDate: '2026-10-13',
      description: 'Hari libur baru',
    });
    const holidayBefore = makeHoliday();
    const holidayUpdated = makeHoliday({ description: 'Hari libur diperbarui' });
    const { service, events } = harness({
      findShift: vi.fn(async () => shiftBefore),
      updateShift: vi.fn(async () => shiftUpdated),
      deactivateShift: vi.fn(async () => ({
        before: shiftUpdated,
        after: makeShift({ name: 'Siang', isActive: false }),
      })),
      createAssignment: vi.fn(async () => assignmentCreated),
      findAssignment: vi.fn(async () => assignmentUpdated),
      updateAssignment: vi
        .fn()
        .mockResolvedValueOnce({ before: assignmentCreated, after: assignmentUpdated })
        .mockResolvedValueOnce({ before: assignmentUpdated, after: assignmentDeactivated }),
      createHoliday: vi.fn(async () => holidayCreated),
      findHoliday: vi.fn(async () => holidayBefore),
      updateHoliday: vi.fn(async () => holidayUpdated),
      deleteHoliday: vi.fn(async () => holidayUpdated),
    });

    await service.updateShift(admin, SHIFT_ID, { name: 'Siang' });
    await service.deactivateShift(admin, SHIFT_ID);
    await service.createAssignment(admin, {
      employeeId: EMPLOYEE_ID,
      workShiftId: SHIFT_ID,
      storeId: STORE_ID,
      effectiveFrom: '2026-10-01',
    });
    await service.updateAssignment(admin, ASSIGNMENT_ID, { effectiveFrom: '2026-10-02' });
    await service.deactivateAssignment(admin, ASSIGNMENT_ID, '2026-10-31');
    await service.createHoliday(admin, {
      holidayDate: '2026-10-13',
      description: 'Hari libur baru',
    });
    await service.updateHoliday(admin, HOLIDAY_ID, { description: 'Hari libur diperbarui' });
    await service.deleteHoliday(admin, HOLIDAY_ID);

    expect(events.map(({ action }) => action)).toEqual([
      'schedule.shift.update',
      'schedule.shift.deactivate',
      'schedule.assignment.create',
      'schedule.assignment.update',
      'schedule.assignment.deactivate',
      'schedule.holiday.create',
      'schedule.holiday.update',
      'schedule.holiday.delete',
    ]);
    expect(events[0]).toMatchObject({ before: { name: 'Pagi' }, after: { name: 'Siang' } });
    expect(events[3]).toMatchObject({
      before: { effectiveFrom: '2026-10-01' },
      after: { effectiveFrom: '2026-10-02' },
    });
    expect(events[4]).toMatchObject({
      before: { effectiveTo: null },
      after: { effectiveTo: '2026-10-31' },
    });
    expect(events[6]).toMatchObject({
      before: { description: 'Hari libur nasional' },
      after: { description: 'Hari libur diperbarui' },
    });
    expect(events[7]).toMatchObject({ before: { description: 'Hari libur diperbarui' } });
  });

  it('treats effective dates as inclusive and rejects overlapping global/store scopes', () => {
    const first = {
      employeeId: EMPLOYEE_ID,
      storeId: STORE_ID,
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
    };
    expect(
      shiftAssignmentsConflict(first, {
        ...first,
        effectiveFrom: '2026-10-10',
        effectiveTo: '2026-10-20',
      }),
    ).toBe(true);
    expect(
      shiftAssignmentsConflict(first, {
        ...first,
        effectiveFrom: '2026-10-11',
        effectiveTo: '2026-10-20',
      }),
    ).toBe(false);
    expect(
      shiftAssignmentsConflict(first, {
        ...first,
        storeId: null,
        effectiveFrom: '2026-10-05',
        effectiveTo: '2026-10-06',
      }),
    ).toBe(true);
    expect(
      shiftAssignmentsConflict(first, {
        ...first,
        storeId: '00000000-0000-4000-8000-000000000099',
      }),
    ).toBe(false);
  });

  it('resolves one employee/store/date assignment and applies national and store holidays', async () => {
    const assignment = makeAssignment();
    const national = makeHoliday();
    const local = makeHoliday({
      id: '00000000-0000-4000-8000-000000000007',
      storeId: STORE_ID,
      description: 'Hari libur toko',
    });
    const listHolidays = vi.fn(async (filter) => (filter.storeId === null ? [national] : [local]));
    const { service } = harness({
      listEffectiveAssignments: async () => [assignment],
      listHolidays,
    });

    const resolved = await service.resolveEffectiveShift(EMPLOYEE_ID, STORE_ID, '2026-10-12');

    expect(resolved).toMatchObject({
      assignment: { id: ASSIGNMENT_ID },
      shift: { id: SHIFT_ID, workDays: [1, 2, 3, 4, 5] },
      businessDate: '2026-10-12',
      isWorkingDay: false,
      holidays: [
        { storeId: null, holidayDate: '2026-10-12' },
        { storeId: STORE_ID, holidayDate: '2026-10-12' },
      ],
    });
    expect(listHolidays).toHaveBeenCalledTimes(2);
    await expect(
      service.resolveEffectiveShift(EMPLOYEE_ID, STORE_ID, '2026-02-30'),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
  });

  it('fails loudly instead of choosing when legacy effective assignments are ambiguous', async () => {
    const { service } = harness({
      listEffectiveAssignments: async () => [makeAssignment(), makeAssignment({ id: SHIFT_ID })],
    });

    await expect(
      service.resolveEffectiveShift(EMPLOYEE_ID, STORE_ID, '2026-10-12'),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_ASSIGNMENT_AMBIGUOUS',
    });
  });

  it('rejects impossible assignment and holiday date ranges before persistence', async () => {
    const createAssignment = vi.fn(async () => makeAssignment());
    const listHolidays = vi.fn(async () => []);
    const { service } = harness({ createAssignment, listHolidays });

    await expect(
      service.createAssignment(admin, {
        employeeId: EMPLOYEE_ID,
        workShiftId: SHIFT_ID,
        effectiveFrom: '2026-10-20',
        effectiveTo: '2026-10-19',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
    await expect(
      service.listHolidays(admin, { from: '2026-10-20', to: '2026-10-19' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCHEDULE_INPUT' });
    expect(createAssignment).not.toHaveBeenCalled();
    expect(listHolidays).not.toHaveBeenCalled();
  });
});
