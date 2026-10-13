import {
  adminAccountsApi,
  type AccountDto,
  type AccountPatch,
  type CreateAccountInput,
  type PasswordResetResult,
  type PendingDeviceBindingDto,
} from '../api/admin-accounts-api.js';
import { adminEmployeesApi, type EmployeeDto } from '../api/admin-employees-api.js';

export type AdminAccountsRequestState = 'idle' | 'loading' | 'ready' | 'error';
export type AdminAccountsMutationState = 'idle' | 'saving';

export type AdminAccountsConfirmation =
  | Readonly<{ kind: 'create-account'; input: CreateAccountInput }>
  | Readonly<{ kind: 'update-account'; accountId: string; patch: AccountPatch }>
  | Readonly<{ kind: 'deactivate-account'; accountId: string }>
  | Readonly<{ kind: 'reset-password'; accountId: string }>
  | Readonly<{ kind: 'approve-device'; bindingId: string }>
  | Readonly<{ kind: 'revoke-device'; bindingId: string }>;

export type AdminAccountsSnapshot = Readonly<{
  accounts: readonly AccountDto[];
  accountsState: AdminAccountsRequestState;
  accountsError: unknown | null;
  employees: readonly EmployeeDto[];
  employeesState: AdminAccountsRequestState;
  employeesError: unknown | null;
  pendingBindings: readonly PendingDeviceBindingDto[];
  bindingsState: AdminAccountsRequestState;
  bindingsError: unknown | null;
  mutation: AdminAccountsMutationState;
  mutationError: unknown | null;
  pendingConfirmation: AdminAccountsConfirmation | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

export type AdminAccountsActionResult =
  | Readonly<{ kind: 'created'; account: AccountDto; temporaryPassword: string }>
  | Readonly<{ kind: 'password-reset'; result: PasswordResetResult }>
  | Readonly<{ kind: 'completed' }>;

const initialSnapshot: AdminAccountsSnapshot = {
  accounts: [],
  accountsState: 'idle',
  accountsError: null,
  employees: [],
  employeesState: 'idle',
  employeesError: null,
  pendingBindings: [],
  bindingsState: 'idle',
  bindingsError: null,
  mutation: 'idle',
  mutationError: null,
  pendingConfirmation: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

export class AdminAccountsModel {
  private snapshot: AdminAccountsSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private accountsRequestId = 0;
  private employeesRequestId = 0;
  private bindingsRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminAccountsSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminAccountsSnapshot => this.snapshot;

  private update(patch: Partial<AdminAccountsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  invalidateRequests(): void {
    this.accountsRequestId += 1;
    this.employeesRequestId += 1;
    this.bindingsRequestId += 1;
  }

  async loadAll(signal?: AbortSignal): Promise<void> {
    await Promise.all([
      this.loadAccounts(signal),
      this.loadEmployees(signal),
      this.loadPendingBindings(signal),
    ]);
  }

  async loadAccounts(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.accountsRequestId;
    this.update({ accountsState: 'loading', accountsError: null });
    try {
      const accounts = await adminAccountsApi.listAccounts(signal);
      if (signal?.aborted || requestId !== this.accountsRequestId) return;
      this.update({ accounts, accountsState: 'ready', accountsError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.accountsRequestId) return;
      this.update({ accountsState: 'error', accountsError: error });
    }
  }

  async loadEmployees(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.employeesRequestId;
    this.update({ employeesState: 'loading', employeesError: null });
    try {
      const employees = await adminEmployeesApi.listEmployees(signal);
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employees, employeesState: 'ready', employeesError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employeesState: 'error', employeesError: error });
    }
  }

  async loadPendingBindings(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.bindingsRequestId;
    this.update({ bindingsState: 'loading', bindingsError: null });
    try {
      const pendingBindings = await adminAccountsApi.listPendingBindings(signal);
      if (signal?.aborted || requestId !== this.bindingsRequestId) return;
      this.update({ pendingBindings, bindingsState: 'ready', bindingsError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.bindingsRequestId) return;
      this.update({ bindingsState: 'error', bindingsError: error });
    }
  }

  requestCreate(input: CreateAccountInput): boolean {
    if (!this.canStartConfirmation()) return false;
    this.update({
      pendingConfirmation: { kind: 'create-account', input },
      confirmationError: null,
      mutationError: null,
      notice: null,
    });
    return true;
  }

  requestUpdate(accountId: string, patch: AccountPatch): boolean {
    if (!this.canStartConfirmation() || Object.keys(patch).length === 0) return false;
    this.update({
      pendingConfirmation: { kind: 'update-account', accountId, patch },
      confirmationError: null,
      mutationError: null,
      notice: null,
    });
    return true;
  }

  requestDeactivation(accountId: string): boolean {
    const account = this.snapshot.accounts.find((item) => item.id === accountId);
    if (!this.canStartConfirmation() || !account || account.status !== 'ACTIVE') return false;
    this.update({
      pendingConfirmation: { kind: 'deactivate-account', accountId },
      confirmationError: null,
      mutationError: null,
      notice: null,
    });
    return true;
  }

  requestPasswordReset(accountId: string): boolean {
    if (!this.canStartConfirmation()) return false;
    this.update({
      pendingConfirmation: { kind: 'reset-password', accountId },
      confirmationError: null,
      mutationError: null,
      notice: null,
    });
    return true;
  }

  requestDeviceApproval(bindingId: string): boolean {
    return this.requestDeviceAction(bindingId, 'approve-device');
  }

  requestDeviceRevocation(bindingId: string): boolean {
    return this.requestDeviceAction(bindingId, 'revoke-device');
  }

  private requestDeviceAction(
    bindingId: string,
    kind: 'approve-device' | 'revoke-device',
  ): boolean {
    const binding = this.snapshot.pendingBindings.find((item) => item.id === bindingId);
    if (!this.canStartConfirmation() || !binding || binding.status !== 'PENDING') return false;
    this.update({
      pendingConfirmation: { kind, bindingId },
      confirmationError: null,
      mutationError: null,
      notice: null,
    });
    return true;
  }

  cancelConfirmation(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingConfirmation: null, confirmationError: null });
  }

  async updateAccount(accountId: string, patch: AccountPatch): Promise<boolean> {
    if (!this.canStartMutation() || Object.keys(patch).length === 0) return false;
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      await adminAccountsApi.updateAccount(accountId, patch);
      this.update({
        mutation: 'idle',
        mutationError: null,
        notice: 'Perubahan akun berhasil disimpan oleh server.',
      });
      void this.loadAccounts();
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  async confirmPending(temporaryPassword?: string): Promise<AdminAccountsActionResult | null> {
    const pending = this.snapshot.pendingConfirmation;
    if (!pending || !this.canStartMutation()) return null;
    if (pending.kind === 'reset-password' && temporaryPassword === undefined) return null;

    this.update({
      mutation: 'saving',
      confirmationBusy: true,
      confirmationError: null,
      mutationError: null,
      notice: null,
    });

    try {
      let result: AdminAccountsActionResult = { kind: 'completed' };
      switch (pending.kind) {
        case 'create-account': {
          const created = await adminAccountsApi.createAccount(pending.input);
          result = { kind: 'created', ...created };
          this.update({
            notice: 'Akun berhasil dibuat. Password sementara hanya ditampilkan sekali.',
          });
          void this.loadAccounts();
          break;
        }
        case 'update-account': {
          await adminAccountsApi.updateAccount(pending.accountId, pending.patch);
          this.update({ notice: 'Perubahan akun berhasil disimpan oleh server.' });
          void this.loadAccounts();
          break;
        }
        case 'deactivate-account': {
          await adminAccountsApi.deactivateAccount(pending.accountId);
          this.update({ notice: 'Akun ditandai tidak aktif oleh server; datanya tidak dihapus.' });
          void this.loadAccounts();
          break;
        }
        case 'reset-password': {
          const reset = await adminAccountsApi.resetPassword(pending.accountId, temporaryPassword!);
          result = { kind: 'password-reset', result: reset };
          this.update({
            notice: 'Password sementara berhasil diatur; pengguna wajib menggantinya.',
          });
          void this.loadAccounts();
          break;
        }
        case 'approve-device': {
          await adminAccountsApi.approveBinding(pending.bindingId);
          this.update({ notice: 'Permintaan perangkat disetujui oleh server.' });
          void this.loadPendingBindings();
          break;
        }
        case 'revoke-device': {
          await adminAccountsApi.revokeBinding(pending.bindingId);
          this.update({ notice: 'Binding perangkat dicabut oleh server.' });
          void this.loadPendingBindings();
          break;
        }
      }

      this.update({
        mutation: 'idle',
        confirmationBusy: false,
        pendingConfirmation: null,
        confirmationError: null,
      });
      return result;
    } catch (error: unknown) {
      this.update({
        mutation: 'idle',
        confirmationBusy: false,
        confirmationError: error,
      });
      return null;
    }
  }

  private canStartConfirmation(): boolean {
    return this.snapshot.mutation === 'idle' && !this.snapshot.confirmationBusy;
  }

  private canStartMutation(): boolean {
    return this.snapshot.mutation === 'idle' && !this.snapshot.confirmationBusy;
  }
}
