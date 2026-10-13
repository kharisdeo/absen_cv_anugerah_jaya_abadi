import { describe, expect, it } from 'vitest';

import type { EmployeeDto } from '../src/api/admin-employees-api.js';
import type { ShiftAssignmentDto } from '../src/api/admin-shift-assignments-api.js';
import type { StoreDto } from '../src/api/admin-stores-api.js';
import type { WorkShiftDto } from '../src/api/admin-shifts-api.js';
import {
  eligibleStoresForEmployee,
  emptyShiftAssignmentDraft,
  shiftAssignmentInputDiff,
  shiftAssignmentToDraft,
  validateAssignmentDeactivationDate,
  validateShiftAssignmentDraft,
} from '../src/pages/admin-shift-assignment-form.js';

const employee: EmployeeDto = {
  id: '00000000-0000-4000-8000-000000000801',
  nik: 'AJ-801',
  fullName: 'Siti Aminah',
  position: 'Kasir',
  status: 'ACTIVE',
  employmentDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const inactiveEmployee: EmployeeDto = {
  ...employee,
  id: '00000000-0000-4000-8000-000000000802',
  status: 'INACTIVE',
};

const shift: WorkShiftDto = {
  id: '00000000-0000-4000-8000-000000000803',
  name: 'Shift Pagi',
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  lateToleranceMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const inactiveShift: WorkShiftDto = {
  ...shift,
  id: '00000000-0000-4000-8000-000000000804',
  isActive: false,
};

const activeStore: StoreDto = {
  id: '00000000-0000-4000-8000-000000000805',
  name: 'Toko Pusat',
  address: null,
  latitude: -6.2,
  longitude: 106.8,
  radiusMeters: 10,
  accuracyLimitMeters: 30,
  wifiPublicIp: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const inactiveStore: StoreDto = {
  ...activeStore,
  id: '00000000-0000-4000-8000-000000000806',
  isActive: false,
};

const assignment: ShiftAssignmentDto = {
  id: '00000000-0000-4000-8000-000000000807',
  employeeId: employee.id,
  workShiftId: shift.id,
  storeId: null,
  assignedByUserAccountId: null,
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  employee: { id: employee.id, nik: employee.nik, fullName: employee.fullName, status: 'ACTIVE' },
  workShift: shift,
};

const options = {
  employees: [employee, inactiveEmployee],
  stores: [activeStore, inactiveStore],
  shifts: [shift, inactiveShift],
  employeeStoreIds: { [employee.id]: [activeStore.id], [inactiveEmployee.id]: [activeStore.id] },
};

describe('admin shift assignment form', () => {
  it('starts with no browser-derived dates and requires an explicit start date', () => {
    expect(emptyShiftAssignmentDraft()).toEqual({
      employeeId: '',
      workShiftId: '',
      scope: '',
      effectiveFrom: '',
      effectiveTo: '',
    });
    const result = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: 'global',
        effectiveFrom: '',
        effectiveTo: '',
      },
      options,
    );
    expect(result.input).toBeUndefined();
    expect(result.errors.effectiveFrom).toBe('Tanggal mulai berlaku wajib diisi.');
  });

  it('accepts inclusive dates, null global scope, and only active employees and shifts for create', () => {
    const result = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: 'global',
        effectiveFrom: '2026-10-01',
        effectiveTo: '2026-10-31',
      },
      options,
    );
    expect(result).toEqual({
      input: {
        employeeId: employee.id,
        workShiftId: shift.id,
        storeId: null,
        effectiveFrom: '2026-10-01',
        effectiveTo: '2026-10-31',
      },
      errors: {},
    });

    const inactive = validateShiftAssignmentDraft(
      {
        employeeId: inactiveEmployee.id,
        workShiftId: inactiveShift.id,
        scope: 'global',
        effectiveFrom: '2026-10-01',
        effectiveTo: '',
      },
      options,
    );
    expect(inactive.input).toBeUndefined();
    expect(inactive.errors.employeeId).toBe('Pilih karyawan aktif.');
    expect(inactive.errors.workShiftId).toBe('Pilih shift aktif.');
  });

  it('offers only active assigned stores for a new assignment and rejects other scopes', () => {
    expect(eligibleStoresForEmployee(employee.id, options)).toEqual([activeStore]);
    const good = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: activeStore.id,
        effectiveFrom: '2026-10-01',
        effectiveTo: '',
      },
      options,
    );
    expect(good.input?.storeId).toBe(activeStore.id);
    expect(good.input?.effectiveTo).toBeNull();

    const bad = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: inactiveStore.id,
        effectiveFrom: '2026-10-01',
        effectiveTo: '',
      },
      options,
    );
    expect(bad.input).toBeUndefined();
    expect(bad.errors.scope).toContain('toko aktif');
  });

  it('rejects impossible dates and an end date before the start date', () => {
    const impossible = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: 'global',
        effectiveFrom: '2026-02-30',
        effectiveTo: '',
      },
      options,
    );
    expect(impossible.input).toBeUndefined();
    expect(impossible.errors.effectiveFrom).toBe('Masukkan tanggal mulai yang valid.');

    const reversed = validateShiftAssignmentDraft(
      {
        employeeId: employee.id,
        workShiftId: shift.id,
        scope: 'global',
        effectiveFrom: '2026-02-02',
        effectiveTo: '2026-02-01',
      },
      options,
    );
    expect(reversed.input).toBeUndefined();
    expect(reversed.errors.effectiveTo).toBe(
      'Tanggal akhir tidak boleh lebih awal dari tanggal mulai.',
    );
  });

  it('keeps employee fixed on edit, retains a legacy scope, and diffs only changed fields', () => {
    const current = {
      ...assignment,
      storeId: inactiveStore.id,
      workShiftId: inactiveShift.id,
      workShift: inactiveShift,
    };
    const draft = shiftAssignmentToDraft(current);
    expect(draft.scope).toBe(inactiveStore.id);
    expect(draft.employeeId).toBe(employee.id);
    expect(eligibleStoresForEmployee(employee.id, { ...options, assignment: current })).toContain(
      inactiveStore,
    );

    const input = {
      employeeId: employee.id,
      workShiftId: shift.id,
      storeId: inactiveStore.id,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
    };
    expect(shiftAssignmentInputDiff(current, input)).toEqual({ workShiftId: shift.id });
    expect(
      shiftAssignmentInputDiff(assignment, {
        employeeId: employee.id,
        workShiftId: shift.id,
        storeId: null,
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
      }),
    ).toEqual({});
  });

  it('requires an explicit valid deactivation date and prevents extending an existing end date', () => {
    const withEnd = { ...assignment, effectiveTo: '2026-10-31' };
    expect(validateAssignmentDeactivationDate('', assignment)).toContain('wajib diisi');
    expect(validateAssignmentDeactivationDate('2026-09-30', assignment)).toContain('lebih awal');
    expect(validateAssignmentDeactivationDate('2026-11-01', withEnd)).toContain('memperpanjang');
    expect(validateAssignmentDeactivationDate('2026-10-15', withEnd)).toBeNull();
  });
});
