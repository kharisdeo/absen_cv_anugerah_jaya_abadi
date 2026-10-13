import type {
  AccountDto,
  AccountPatch,
  AccountRole,
  AccountStatus,
  CreateAccountInput,
} from '../api/admin-accounts-api.js';
import type { EmployeeDto } from '../api/admin-employees-api.js';

export type AccountDraft = Readonly<{
  username: string;
  role: AccountRole | '';
  status: AccountStatus | '';
  employeeId: string;
}>;

export type AccountDraftErrors = Partial<Record<keyof AccountDraft, string>>;

export function emptyAccountDraft(): AccountDraft {
  return { username: '', role: '', status: '', employeeId: '' };
}

export function accountToDraft(account: AccountDto): AccountDraft {
  return {
    username: account.username,
    role: account.role,
    status: account.status,
    employeeId: account.employeeId ?? '',
  };
}

function usernameError(value: string): string | undefined {
  const username = value.trim();
  if (!username) return 'Nama pengguna wajib diisi.';
  if (username.length > 256) return 'Nama pengguna maksimal 256 karakter.';
  if (
    [...username].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return 'Nama pengguna tidak boleh berisi karakter kontrol.';
  }
  return undefined;
}

export function validateCreateAccountDraft(draft: AccountDraft): Readonly<{
  errors: AccountDraftErrors;
  input: CreateAccountInput | null;
}> {
  const errors: AccountDraftErrors = {};
  const invalidUsername = usernameError(draft.username);
  if (invalidUsername) errors.username = invalidUsername;
  if (!draft.role) errors.role = 'Pilih peran akun.';

  if (Object.keys(errors).length > 0 || !draft.role) return { errors, input: null };
  const input: CreateAccountInput = {
    username: draft.username.trim(),
    role: draft.role,
    ...(draft.employeeId ? { employeeId: draft.employeeId } : {}),
  };
  return { errors, input };
}

export function buildAccountPatch(account: AccountDto, draft: AccountDraft): AccountPatch | null {
  const username = draft.username.trim();
  if (!username || !draft.role || !draft.status) return null;

  const patch: {
    username?: string;
    role?: AccountRole;
    status?: AccountStatus;
    employeeId?: string | null;
  } = {};
  if (username !== account.username) patch.username = username;
  if (draft.role !== account.role) patch.role = draft.role;
  if (draft.status !== account.status) patch.status = draft.status;
  const employeeId = draft.employeeId || null;
  if (employeeId !== account.employeeId) patch.employeeId = employeeId;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function validateEditAccountDraft(draft: AccountDraft): AccountDraftErrors {
  const errors: AccountDraftErrors = {};
  const invalidUsername = usernameError(draft.username);
  if (invalidUsername) errors.username = invalidUsername;
  if (!draft.role) errors.role = 'Pilih peran akun.';
  if (!draft.status) errors.status = 'Pilih status akun.';
  return errors;
}

/** Only changes to role, status, or employee linkage require an extra confirmation. */
export function requiresAccountUpdateConfirmation(patch: AccountPatch): boolean {
  return patch.role !== undefined || patch.status !== undefined || patch.employeeId !== undefined;
}

export function getAssignableEmployees(
  employees: readonly EmployeeDto[],
  accounts: readonly AccountDto[],
  editingAccountId: string | null,
): readonly EmployeeDto[] {
  const linkedElsewhere = new Set(
    accounts
      .filter((account) => account.id !== editingAccountId && account.employeeId !== null)
      .map((account) => account.employeeId),
  );
  return employees.filter((employee) => !linkedElsewhere.has(employee.id));
}

export function employeeOptionLabel(employee: EmployeeDto): string {
  const status = employee.status === 'ACTIVE' ? 'aktif' : 'tidak aktif';
  return `${employee.fullName} · NIK ${employee.nik} · ${status}`;
}

export function temporaryPasswordError(value: string): string | null {
  if (value.length === 0) return 'Password sementara wajib diisi.';
  if (value.length > 1_024) return 'Password sementara maksimal 1.024 karakter.';
  if (new TextEncoder().encode(value).length > 4_096) {
    return 'Password sementara maksimal 4.096 byte dalam UTF-8.';
  }
  return null;
}
