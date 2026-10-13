import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listAssignments: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  deactivateAssignment: vi.fn(),
  listEmployees: vi.fn(),
  listStores: vi.fn(),
  listStoreAssignments: vi.fn(),
}));

vi.mock('../src/api/admin-shift-assignments-api.js', () => ({
  adminShiftAssignmentsApi: {
    listAssignments: api.listAssignments,
    createAssignment: api.createAssignment,
    updateAssignment: api.updateAssignment,
    deactivateAssignment: api.deactivateAssignment,
  },
}));
vi.mock('../src/api/admin-employees-api.js', () => ({
  adminEmployeesApi: { listEmployees: api.listEmployees },
}));
vi.mock('../src/api/admin-stores-api.js', () => ({
  adminStoresApi: {
    listStores: api.listStores,
    listAssignments: api.listStoreAssignments,
  },
}));

import type { EmployeeDto } from '../src/api/admin-employees-api.js';
import type { ShiftAssignmentDto } from '../src/api/admin-shift-assignments-api.js';
import type { StoreDto, StoreAssignmentDto } from '../src/api/admin-stores-api.js';
import { AdminShiftAssignmentsModel } from '../src/pages/admin-shift-assignments-model.js';

const employeeId = '00000000-0000-4000-8000-000000000901';
const storeId = '00000000-0000-4000-8000-000000000902';
const inactiveStoreId = '00000000-0000-4000-8000-000000000903';
const shiftId = '00000000-0000-4000-8000-000000000904';
const assignmentId = '00000000-0000-4000-8000-000000000905';

const employee: EmployeeDto = {
  id: employeeId,
  nik: 'AJ-901',
  fullName: 'Siti Aminah',
  position: 'Kasir',
  status: 'ACTIVE',
  employmentDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const activeStore: StoreDto = {
  id: storeId,
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

const inactiveStore: StoreDto = { ...activeStore, id: inactiveStoreId, isActive: false };

const storeAssignment: StoreAssignmentDto = {
  storeId,
  employeeId,
  assignedByUserAccountId: '00000000-0000-4000-8000-000000000906',
  assignedAt: '2026-01-01T00:00:00.000Z',
  employee: { id: employeeId, nik: employee.nik, fullName: employee.fullName, status: 'ACTIVE' },
};

const assignment: ShiftAssignmentDto = {
  id: assignmentId,
  employeeId,
  workShiftId: shiftId,
  storeId: null,
  assignedByUserAccountId: null,
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  employee: { id: employeeId, nik: employee.nik, fullName: employee.fullName, status: 'ACTIVE' },
  workShift: {
    id: shiftId,
    name: 'Shift Pagi',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    lateToleranceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

async function readyModel(): Promise<AdminShiftAssignmentsModel> {
  const model = new AdminShiftAssignmentsModel();
  await Promise.all([model.loadAssignments(), model.loadReferences()]);
  return model;
}

describe('admin shift assignments state model', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listAssignments.mockResolvedValue([assignment]);
    api.listEmployees.mockResolvedValue([employee]);
    api.listStores.mockResolvedValue([activeStore, inactiveStore]);
    api.listStoreAssignments.mockResolvedValue([storeAssignment]);
  });

  it('loads assignment rows and only resolves store membership for active stores', async () => {
    const model = await readyModel();
    expect(model.getSnapshot()).toMatchObject({
      assignments: [assignment],
      assignmentsState: 'ready',
      referencesState: 'ready',
      employees: [employee],
      stores: [activeStore, inactiveStore],
      employeeStoreIds: { [employeeId]: [storeId] },
    });
    expect(api.listStoreAssignments).toHaveBeenCalledTimes(1);
    expect(api.listStoreAssignments).toHaveBeenCalledWith(storeId, undefined);
  });

  it('keeps reference errors explicit and retryable', async () => {
    api.listEmployees.mockRejectedValueOnce(new Error('hidden service payload'));
    const model = new AdminShiftAssignmentsModel();
    await model.loadReferences();
    expect(model.getSnapshot()).toMatchObject({
      referencesState: 'error',
      referencesError: expect.any(Error),
    });

    await model.loadReferences();
    expect(model.getSnapshot().referencesState).toBe('ready');
  });

  it('uses server DTOs for create and update and does not submit a mutation before asking the model', async () => {
    const model = await readyModel();
    const createInput = {
      employeeId,
      workShiftId: shiftId,
      storeId: null,
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
    };
    const created = { ...assignment, id: '00000000-0000-4000-8000-000000000907', ...createInput };
    api.createAssignment.mockResolvedValueOnce(created);
    await expect(model.saveAssignment(null, createInput)).resolves.toBe(true);
    expect(api.createAssignment).toHaveBeenCalledWith(createInput);
    expect(model.getSnapshot().assignments).toHaveLength(2);

    const updated = { ...created, effectiveTo: '2026-11-30' };
    api.updateAssignment.mockResolvedValueOnce(updated);
    await expect(model.saveAssignment(created.id, { effectiveTo: '2026-11-30' })).resolves.toBe(
      true,
    );
    expect(api.updateAssignment).toHaveBeenCalledWith(created.id, { effectiveTo: '2026-11-30' });
    expect(
      model.getSnapshot().assignments.find((item) => item.id === created.id)?.effectiveTo,
    ).toBe('2026-11-30');
  });

  it('requires confirmation and sends the explicit inclusive date; failures remain retryable', async () => {
    const model = await readyModel();
    model.requestDeactivation(assignment.id);
    expect(api.deactivateAssignment).not.toHaveBeenCalled();
    expect(model.getSnapshot().pendingDeactivation).toEqual(assignment);

    api.deactivateAssignment.mockRejectedValueOnce(new Error('hidden conflict response'));
    await expect(model.confirmDeactivation('2026-10-31')).resolves.toBe(false);
    expect(model.getSnapshot()).toMatchObject({
      pendingDeactivation: assignment,
      confirmationError: expect.any(Error),
      confirmationBusy: false,
    });

    api.deactivateAssignment.mockResolvedValueOnce({ ...assignment, effectiveTo: '2026-10-31' });
    await expect(model.confirmDeactivation('2026-10-31')).resolves.toBe(true);
    expect(api.deactivateAssignment).toHaveBeenLastCalledWith(assignment.id, '2026-10-31');
    expect(model.getSnapshot()).toMatchObject({
      pendingDeactivation: null,
      notice: expect.any(String),
    });
  });
});
