import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminAccountsApi,
  type AccountDto,
  type PendingDeviceBindingDto,
} from '../src/api/admin-accounts-api.js';
import { adminEmployeesApi, type EmployeeDto } from '../src/api/admin-employees-api.js';
import {
  buildAccountPatch,
  emptyAccountDraft,
  getAssignableEmployees,
  requiresAccountUpdateConfirmation,
  temporaryPasswordError,
  validateCreateAccountDraft,
} from '../src/pages/admin-account-form.js';
import { AdminAccountsModel } from '../src/pages/admin-accounts-model.js';

vi.mock('../src/api/admin-accounts-api.js', () => ({
  adminAccountsApi: {
    listAccounts: vi.fn(),
    getAccount: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    deactivateAccount: vi.fn(),
    resetPassword: vi.fn(),
    listPendingBindings: vi.fn(),
    approveBinding: vi.fn(),
    revokeBinding: vi.fn(),
  },
}));

vi.mock('../src/api/admin-employees-api.js', () => ({
  adminEmployeesApi: { listEmployees: vi.fn() },
}));

const account: AccountDto = {
  id: '00000000-0000-4000-8000-000000000601',
  username: 'admin.satu',
  role: 'ADMIN',
  status: 'ACTIVE',
  employeeId: null,
  mustChangePassword: false,
  createdAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:00.000Z',
};

const linkedAccount: AccountDto = {
  ...account,
  id: '00000000-0000-4000-8000-000000000602',
  employeeId: '00000000-0000-4000-8000-000000000603',
};

const employee: EmployeeDto = {
  id: '00000000-0000-4000-8000-000000000603',
  nik: 'AJ-603',
  fullName: 'Karyawan Tertaut',
  position: null,
  status: 'ACTIVE',
  employmentDate: null,
  createdAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:00.000Z',
};

const pendingBinding: PendingDeviceBindingDto = {
  id: '00000000-0000-4000-8000-000000000604',
  employeeId: employee.id,
  deviceName: 'Chrome Android',
  status: 'PENDING',
  requestedAt: '2026-10-11T02:00:00.000Z',
  approvedAt: null,
  revokedAt: null,
  createdAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:00.000Z',
};

const accountsApi = vi.mocked(adminAccountsApi);
const employeesApi = vi.mocked(adminEmployeesApi);

describe('Admin account draft rules', () => {
  it('omits server-default status on create and requires a selected role', () => {
    const draft = { ...emptyAccountDraft(), username: ' new.user ', role: 'EMPLOYEE' as const };
    expect(validateCreateAccountDraft(draft)).toEqual({
      errors: {},
      input: { username: 'new.user', role: 'EMPLOYEE' },
    });
    expect(validateCreateAccountDraft({ ...draft, role: '' }).input).toBeNull();
  });

  it('builds a minimal patch and requires confirmation only for high-impact fields', () => {
    const usernameOnly = buildAccountPatch(account, {
      username: 'admin.baru',
      role: 'ADMIN',
      status: 'ACTIVE',
      employeeId: '',
    });
    expect(usernameOnly).toEqual({ username: 'admin.baru' });
    expect(requiresAccountUpdateConfirmation(usernameOnly ?? {})).toBe(false);

    const roleChange = buildAccountPatch(account, {
      username: account.username,
      role: 'SUPERVISOR',
      status: account.status,
      employeeId: '',
    });
    expect(roleChange).toEqual({ role: 'SUPERVISOR' });
    expect(requiresAccountUpdateConfirmation(roleChange ?? {})).toBe(true);

    const unlink = buildAccountPatch(linkedAccount, {
      username: linkedAccount.username,
      role: linkedAccount.role,
      status: linkedAccount.status,
      employeeId: '',
    });
    expect(unlink).toEqual({ employeeId: null });
    expect(requiresAccountUpdateConfirmation(unlink ?? {})).toBe(true);
  });

  it('offers employee profiles only when unlinked or already linked to the edited account', () => {
    const otherEmployee: EmployeeDto = { ...employee, id: 'other-id', nik: 'AJ-604' };
    const availableForCreate = getAssignableEmployees(
      [employee, otherEmployee],
      [linkedAccount],
      null,
    );
    expect(availableForCreate).toEqual([otherEmployee]);

    const availableWhenEditing = getAssignableEmployees(
      [employee, otherEmployee],
      [linkedAccount],
      linkedAccount.id,
    );
    expect(availableWhenEditing).toEqual([employee, otherEmployee]);
  });

  it('enforces only the server-specified temporary password bounds, without complexity rules', () => {
    expect(temporaryPasswordError('x')).toBeNull();
    expect(temporaryPasswordError('')).toContain('wajib');
    expect(temporaryPasswordError('😀'.repeat(512))).toBeNull();
    expect(temporaryPasswordError('😀'.repeat(513))).toContain('1.024');
    expect(temporaryPasswordError('é'.repeat(1_024))).toBeNull();
    expect(temporaryPasswordError('é'.repeat(1_025))).toContain('1.024');
  });
});

describe('AdminAccountsModel confirmation and secret handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsApi.listAccounts.mockResolvedValue([]);
    accountsApi.listPendingBindings.mockResolvedValue([]);
    accountsApi.createAccount.mockResolvedValue({
      account: { ...account, username: 'admin.baru' },
      temporaryPassword: 'one-time-server-secret',
    });
    accountsApi.updateAccount.mockResolvedValue(account);
    accountsApi.deactivateAccount.mockResolvedValue({ ...account, status: 'INACTIVE' });
    accountsApi.resetPassword.mockResolvedValue({
      accountId: account.id,
      mustChangePassword: true,
    });
    accountsApi.approveBinding.mockResolvedValue({ ...pendingBinding, status: 'APPROVED' });
    accountsApi.revokeBinding.mockResolvedValue({ ...pendingBinding, status: 'REVOKED' });
    employeesApi.listEmployees.mockResolvedValue([employee]);
  });

  it('does not create until confirmed and returns the server password outside the snapshot only', async () => {
    const model = new AdminAccountsModel();
    model.requestCreate({ username: 'admin.baru', role: 'ADMIN' });
    expect(accountsApi.createAccount).not.toHaveBeenCalled();

    const result = await model.confirmPending();
    expect(accountsApi.createAccount).toHaveBeenCalledWith({
      username: 'admin.baru',
      role: 'ADMIN',
    });
    expect(result).toEqual({
      kind: 'created',
      account: { ...account, username: 'admin.baru' },
      temporaryPassword: 'one-time-server-secret',
    });
    expect(JSON.stringify(model.getSnapshot())).not.toContain('one-time-server-secret');
    expect(Object.keys(model.getSnapshot()).some((key) => /password/i.test(key))).toBe(false);
  });

  it('confirms high-impact edits and sends only the fields that changed', async () => {
    const model = new AdminAccountsModel();
    expect(model.requestUpdate(account.id, { status: 'SUSPENDED' })).toBe(true);
    expect(accountsApi.updateAccount).not.toHaveBeenCalled();

    await model.confirmPending();
    expect(accountsApi.updateAccount).toHaveBeenCalledWith(account.id, { status: 'SUSPENDED' });
  });

  it('sends deactivation to the server and surfaces its active-Admin floor response', async () => {
    const model = new AdminAccountsModel();
    accountsApi.listAccounts.mockResolvedValue([account]);
    await model.loadAccounts();
    expect(model.requestDeactivation(account.id)).toBe(true);
    expect(accountsApi.deactivateAccount).not.toHaveBeenCalled();

    accountsApi.deactivateAccount.mockRejectedValueOnce({
      status: 409,
      code: 'ACTIVE_ADMIN_FLOOR',
    });
    expect(await model.confirmPending()).toBeNull();
    expect(accountsApi.deactivateAccount).toHaveBeenCalledWith(account.id);
    expect(model.getSnapshot().confirmationError).toMatchObject({ code: 'ACTIVE_ADMIN_FLOOR' });
  });

  it('does not put reset passwords in the model and displays the server must-change result', async () => {
    const model = new AdminAccountsModel();
    model.requestPasswordReset(account.id);
    expect(JSON.stringify(model.getSnapshot())).not.toContain('private-reset-secret');
    expect(accountsApi.resetPassword).not.toHaveBeenCalled();

    const result = await model.confirmPending('private-reset-secret');
    expect(accountsApi.resetPassword).toHaveBeenCalledWith(account.id, 'private-reset-secret');
    expect(result).toEqual({
      kind: 'password-reset',
      result: { accountId: account.id, mustChangePassword: true },
    });
    expect(JSON.stringify(model.getSnapshot())).not.toContain('private-reset-secret');
  });

  it('requires confirmation for device actions and refreshes the pending list afterward', async () => {
    const model = new AdminAccountsModel();
    accountsApi.listPendingBindings.mockResolvedValue([pendingBinding]);
    await model.loadPendingBindings();

    expect(model.requestDeviceApproval(pendingBinding.id)).toBe(true);
    expect(accountsApi.approveBinding).not.toHaveBeenCalled();
    await model.confirmPending();
    expect(accountsApi.approveBinding).toHaveBeenCalledWith(pendingBinding.id);
    expect(accountsApi.listPendingBindings).toHaveBeenCalledTimes(2);

    await model.loadPendingBindings();
    expect(model.requestDeviceRevocation(pendingBinding.id)).toBe(true);
    expect(accountsApi.revokeBinding).not.toHaveBeenCalled();
    await model.confirmPending();
    expect(accountsApi.revokeBinding).toHaveBeenCalledWith(pendingBinding.id);
  });
});
