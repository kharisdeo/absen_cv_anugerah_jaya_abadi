import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listEmployees: vi.fn(),
  getEmployee: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  deactivateEmployee: vi.fn(),
}));

vi.mock('../src/api/admin-employees-api.js', () => ({ adminEmployeesApi: api }));

import type { EmployeeDto } from '../src/api/admin-employees-api.js';
import { AdminEmployeesModel } from '../src/pages/admin-employees-model.js';

const employee: EmployeeDto = {
  id: '00000000-0000-4000-8000-000000000301',
  nik: 'AJ-001',
  fullName: 'Nama Karyawan',
  position: null,
  status: 'ACTIVE',
  employmentDate: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function loadModel(model: AdminEmployeesModel) {
  api.listEmployees.mockResolvedValue([employee]);
  await model.loadEmployees();
}

describe('admin employees state model', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads only real server employees and begins an edit from a server detail', async () => {
    const model = new AdminEmployeesModel();
    await loadModel(model);
    api.getEmployee.mockResolvedValue(employee);

    await model.beginEdit(employee.id);
    expect(model.getSnapshot()).toMatchObject({
      employees: [employee],
      employeesState: 'ready',
      editorState: 'ready',
      editorEmployee: employee,
    });
    expect(api.getEmployee).toHaveBeenCalledWith(employee.id, undefined);
  });

  it('creates and updates profile data only after server acknowledgement', async () => {
    const model = new AdminEmployeesModel();
    await loadModel(model);
    model.beginCreate();
    const created = { ...employee, id: '00000000-0000-4000-8000-000000000302', nik: 'AJ-002' };
    api.createEmployee.mockResolvedValue(created);

    await expect(
      model.createEmployee({
        nik: 'AJ-002',
        fullName: 'Nama Karyawan',
        position: null,
        employmentDate: null,
      }),
    ).resolves.toBe(true);
    expect(model.getSnapshot().employees).toContainEqual(created);
    expect(model.getSnapshot().editorState).toBe('closed');

    api.updateEmployee.mockResolvedValue({ ...employee, position: 'Supervisor' });
    await expect(model.updateEmployee(employee.id, { position: 'Supervisor' })).resolves.toBe(true);
    expect(api.updateEmployee).toHaveBeenCalledWith(employee.id, { position: 'Supervisor' });
  });

  it('requires confirmation to deactivate and retains inactive employees without reactivation UI state', async () => {
    const model = new AdminEmployeesModel();
    await loadModel(model);
    model.requestDeactivation(employee.id);
    expect(api.deactivateEmployee).not.toHaveBeenCalled();

    model.cancelDeactivation();
    expect(model.getSnapshot().pendingDeactivation).toBeNull();
    model.requestDeactivation(employee.id);
    api.deactivateEmployee.mockResolvedValue({ ...employee, status: 'INACTIVE' });
    await expect(model.confirmDeactivation()).resolves.toBe(true);
    expect(api.deactivateEmployee).toHaveBeenCalledWith(employee.id);
    expect(model.getSnapshot().employees[0]?.status).toBe('INACTIVE');
    expect(model.getSnapshot().pendingDeactivation).toBeNull();

    model.requestDeactivation(employee.id);
    expect(model.getSnapshot().pendingDeactivation).toBeNull();
  });
});
