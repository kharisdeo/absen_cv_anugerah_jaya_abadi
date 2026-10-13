import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listStores: vi.fn(),
  listEmployees: vi.fn(),
  listAssignments: vi.fn(),
  createStore: vi.fn(),
  updateStore: vi.fn(),
  deactivateStore: vi.fn(),
  assignEmployee: vi.fn(),
  removeEmployee: vi.fn(),
}));

vi.mock('../src/api/admin-stores-api.js', () => ({ adminStoresApi: api }));

import type {
  EmployeeOptionDto,
  StoreAssignmentDto,
  StoreDto,
} from '../src/api/admin-stores-api.js';
import { AdminStoresModel } from '../src/pages/admin-stores-model.js';

const store: StoreDto = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Toko Contoh',
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

const activeEmployee: EmployeeOptionDto = {
  id: '00000000-0000-4000-8000-000000000102',
  nik: 'AJ-001',
  fullName: 'Karyawan Aktif',
  position: null,
  status: 'ACTIVE',
  employmentDate: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const inactiveEmployee: EmployeeOptionDto = {
  ...activeEmployee,
  id: 'inactive-id',
  status: 'INACTIVE',
};

const assignment: StoreAssignmentDto = {
  storeId: store.id,
  employeeId: activeEmployee.id,
  assignedByUserAccountId: '00000000-0000-4000-8000-000000000103',
  assignedAt: '2026-01-01T00:00:00.000Z',
  employee: {
    id: activeEmployee.id,
    nik: activeEmployee.nik,
    fullName: activeEmployee.fullName,
    status: 'ACTIVE',
  },
};

async function loadModel(model: AdminStoresModel, assignments: readonly StoreAssignmentDto[] = []) {
  api.listStores.mockResolvedValue([store]);
  api.listEmployees.mockResolvedValue([activeEmployee, inactiveEmployee]);
  api.listAssignments.mockResolvedValue(assignments);
  await Promise.all([model.loadStores(), model.loadEmployees()]);
  await model.loadAssignments(store.id);
}

describe('admin stores state model', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads server data and selects a real store without fabricating dashboard values', async () => {
    const model = new AdminStoresModel();
    await loadModel(model);

    expect(model.getSnapshot()).toMatchObject({
      stores: [store],
      storesState: 'ready',
      selectedStoreId: store.id,
      employees: [activeEmployee, inactiveEmployee],
      assignments: [],
      assignmentsState: 'ready',
    });
  });

  it('only assigns active unassigned employees and refreshes the server assignment list', async () => {
    const model = new AdminStoresModel();
    await loadModel(model);
    api.listAssignments.mockResolvedValueOnce([assignment]);
    api.assignEmployee.mockResolvedValue(assignment);

    await expect(model.assignEmployee(store.id, inactiveEmployee.id)).resolves.toBe(false);
    await expect(model.assignEmployee(store.id, activeEmployee.id)).resolves.toBe(true);

    expect(api.assignEmployee).toHaveBeenCalledTimes(1);
    expect(api.assignEmployee).toHaveBeenCalledWith(store.id, activeEmployee.id);
    expect(model.getSnapshot().assignments).toEqual([assignment]);
  });

  it('requires explicit confirmation before deactivating a store', async () => {
    const model = new AdminStoresModel();
    await loadModel(model);
    const inactiveStore = { ...store, isActive: false };
    api.deactivateStore.mockResolvedValue(inactiveStore);

    model.requestDeactivate(store.id);
    expect(api.deactivateStore).not.toHaveBeenCalled();
    expect(model.getSnapshot().pendingConfirmation).toEqual({
      action: 'deactivate',
      storeId: store.id,
    });

    await model.confirmPendingAction();
    expect(api.deactivateStore).toHaveBeenCalledWith(store.id);
    expect(model.getSnapshot().stores[0]?.isActive).toBe(false);
    expect(model.getSnapshot().pendingConfirmation).toBeNull();
  });

  it('does not update location validation settings until the Admin confirms', async () => {
    const model = new AdminStoresModel();
    await loadModel(model);
    const input = {
      name: store.name,
      address: store.address,
      latitude: -6.21,
      longitude: store.longitude,
      radiusMeters: 20,
      accuracyLimitMeters: store.accuracyLimitMeters,
      wifiPublicIp: store.wifiPublicIp,
    };
    const updatedStore = { ...store, ...input };
    api.updateStore.mockResolvedValue(updatedStore);

    model.requestStoreUpdateConfirmation(store.id, input, ['Koordinat lokasi', 'Radius lokasi']);
    expect(api.updateStore).not.toHaveBeenCalled();
    expect(model.getSnapshot().pendingConfirmation).toMatchObject({
      action: 'update-store',
      storeId: store.id,
      changedFields: ['Koordinat lokasi', 'Radius lokasi'],
    });

    await expect(model.confirmPendingAction()).resolves.toBe(true);
    expect(api.updateStore).toHaveBeenCalledWith(store.id, input);
    expect(model.getSnapshot()).toMatchObject({
      stores: [updatedStore],
      pendingConfirmation: null,
      confirmationError: null,
      storeMutation: 'idle',
    });
  });

  it('retains the confirmation and existing store when the confirmed update fails', async () => {
    const model = new AdminStoresModel();
    await loadModel(model);
    const input = {
      name: store.name,
      address: store.address,
      latitude: store.latitude,
      longitude: store.longitude,
      radiusMeters: 25,
      accuracyLimitMeters: store.accuracyLimitMeters,
      wifiPublicIp: store.wifiPublicIp,
    };
    const safeApiError = { status: 409, code: 'STORE_NAME_CONFLICT' };
    api.updateStore.mockRejectedValue(safeApiError);

    model.requestStoreUpdateConfirmation(store.id, input, ['Radius lokasi']);
    await expect(model.confirmPendingAction()).resolves.toBe(false);

    expect(model.getSnapshot()).toMatchObject({
      stores: [store],
      pendingConfirmation: { action: 'update-store', storeId: store.id },
      confirmationError: safeApiError,
      storeMutation: 'idle',
      confirmationBusy: false,
    });
  });

  it('cancels assignment removal without a request and removes only after confirmation', async () => {
    const model = new AdminStoresModel();
    await loadModel(model, [assignment]);
    api.removeEmployee.mockResolvedValue(undefined);
    api.listAssignments.mockResolvedValueOnce([]);

    model.requestAssignmentRemoval(assignment);
    model.cancelConfirmation();
    expect(api.removeEmployee).not.toHaveBeenCalled();

    model.requestAssignmentRemoval(assignment);
    await model.confirmPendingAction();
    expect(api.removeEmployee).toHaveBeenCalledWith(store.id, activeEmployee.id);
    expect(model.getSnapshot().assignments).toEqual([]);
  });

  it('does not deactivate a store that the server already marks inactive', async () => {
    const model = new AdminStoresModel();
    api.listStores.mockResolvedValue([{ ...store, isActive: false }]);
    await model.loadStores();

    model.requestDeactivate(store.id);
    expect(model.getSnapshot().pendingConfirmation).toBeNull();
    expect(api.deactivateStore).not.toHaveBeenCalled();
  });
});
