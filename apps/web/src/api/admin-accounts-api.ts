import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';
import {
  API_ACCOUNT_ROLES,
  API_ACCOUNT_STATUSES,
  API_DEVICE_BINDING_STATUSES,
  type ApiAccountRole,
  type ApiAccountStatus,
  type ApiDeviceBindingStatus,
} from './api-contract.js';

export type AccountRole = ApiAccountRole;
export type AccountStatus = ApiAccountStatus;

export type AccountDto = Readonly<{
  id: string;
  username: string;
  role: AccountRole;
  status: AccountStatus;
  employeeId: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateAccountInput = Readonly<{
  username: string;
  role: AccountRole;
  employeeId?: string;
}>;

export type AccountPatch = Readonly<{
  username?: string;
  role?: AccountRole;
  status?: AccountStatus;
  employeeId?: string | null;
}>;

export type CreatedAccount = Readonly<{
  account: AccountDto;
  temporaryPassword: string;
}>;

export type DeviceBindingDto = Readonly<{
  id: string;
  employeeId: string;
  deviceName: string;
  status: ApiDeviceBindingStatus;
  requestedAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type PendingDeviceBindingDto = Omit<DeviceBindingDto, 'status'> &
  Readonly<{ status: 'PENDING' }>;

export type PasswordResetResult = Readonly<{
  accountId: string;
  mustChangePassword: true;
}>;

export class AdminAccountsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan akun atau perangkat belum berhasil.',
    );
    this.name = 'AdminAccountsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (API_ACCOUNT_ROLES as readonly string[]).includes(value);
}

function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (API_ACCOUNT_STATUSES as readonly string[]).includes(value);
}

function parseAccount(value: unknown): AccountDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.username !== 'string' ||
    !isAccountRole(value.role) ||
    !isAccountStatus(value.status) ||
    !nullableString(value.employeeId) ||
    typeof value.mustChangePassword !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
  }

  // Project only fields in the public contract; never pass through unknown server fields.
  return {
    id: value.id,
    username: value.username,
    role: value.role,
    status: value.status,
    employeeId: value.employeeId,
    mustChangePassword: value.mustChangePassword,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parsePendingBinding(value: unknown): PendingDeviceBindingDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.employeeId !== 'string' ||
    typeof value.deviceName !== 'string' ||
    !API_DEVICE_BINDING_STATUSES.includes(value.status as ApiDeviceBindingStatus) ||
    value.status !== 'PENDING' ||
    typeof value.requestedAt !== 'string' ||
    !nullableString(value.approvedAt) ||
    !nullableString(value.revokedAt) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
  }

  return {
    id: value.id,
    employeeId: value.employeeId,
    deviceName: value.deviceName,
    status: 'PENDING',
    requestedAt: value.requestedAt,
    approvedAt: value.approvedAt,
    revokedAt: value.revokedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

async function send(
  path: string,
  method: 'GET' | 'POST' | 'PATCH',
  options: Readonly<{ body?: Readonly<Record<string, unknown>>; signal?: AbortSignal }> = {},
): Promise<Response> {
  const { body, signal } = options;
  return apiFetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: 'include',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function readJson(response: Response, expectedStatus: number): Promise<unknown> {
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new AdminAccountsApiError(status, code, requestId),
  );
}

function parseAccountArray(value: unknown): readonly AccountDto[] {
  if (!Array.isArray(value)) throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
  return value.map(parseAccount);
}

function parseBindingArray(value: unknown): readonly PendingDeviceBindingDto[] {
  if (!Array.isArray(value)) throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
  return value.map(parsePendingBinding);
}

const accountsPath = '/admin/accounts';
const bindingsPath = '/admin/device-bindings';

export const adminAccountsApi = {
  async listAccounts(signal?: AbortSignal): Promise<readonly AccountDto[]> {
    const response = await send(accountsPath, 'GET', signal ? { signal } : {});
    return parseAccountArray(await readJson(response, 200));
  },

  async getAccount(accountId: string, signal?: AbortSignal): Promise<AccountDto> {
    const response = await send(
      `${accountsPath}/${encodeURIComponent(accountId)}`,
      'GET',
      signal ? { signal } : {},
    );
    return parseAccount(await readJson(response, 200));
  },

  async createAccount(input: CreateAccountInput): Promise<CreatedAccount> {
    const response = await send(accountsPath, 'POST', { body: input });
    const payload = await readJson(response, 201);
    if (
      !isRecord(payload) ||
      typeof payload.temporaryPassword !== 'string' ||
      payload.temporaryPassword.length === 0
    ) {
      throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
    }
    return { account: parseAccount(payload.account), temporaryPassword: payload.temporaryPassword };
  },

  async updateAccount(accountId: string, patch: AccountPatch): Promise<AccountDto> {
    const response = await send(`${accountsPath}/${encodeURIComponent(accountId)}`, 'PATCH', {
      body: patch,
    });
    return parseAccount(await readJson(response, 200));
  },

  async deactivateAccount(accountId: string): Promise<AccountDto> {
    const response = await send(
      `${accountsPath}/${encodeURIComponent(accountId)}/deactivate`,
      'POST',
    );
    return parseAccount(await readJson(response, 200));
  },

  async resetPassword(accountId: string, temporaryPassword: string): Promise<PasswordResetResult> {
    const response = await send(
      `/auth/admin/accounts/${encodeURIComponent(accountId)}/reset-password`,
      'POST',
      { body: { temporaryPassword } },
    );
    const payload = await readJson(response, 200);
    if (
      !isRecord(payload) ||
      typeof payload.accountId !== 'string' ||
      payload.accountId !== accountId ||
      payload.mustChangePassword !== true
    ) {
      throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
    }
    return { accountId: payload.accountId, mustChangePassword: true };
  },

  async listPendingBindings(signal?: AbortSignal): Promise<readonly PendingDeviceBindingDto[]> {
    const response = await send(`${bindingsPath}/pending`, 'GET', signal ? { signal } : {});
    return parseBindingArray(await readJson(response, 200));
  },

  async approveBinding(bindingId: string): Promise<DeviceBindingDto> {
    const response = await send(
      `${bindingsPath}/${encodeURIComponent(bindingId)}/approve`,
      'POST',
      { body: {} },
    );
    return parseBindingMutation(await readJson(response, 200));
  },

  async revokeBinding(bindingId: string): Promise<DeviceBindingDto> {
    const response = await send(`${bindingsPath}/${encodeURIComponent(bindingId)}/revoke`, 'POST', {
      body: {},
    });
    return parseBindingMutation(await readJson(response, 200));
  },
};

function parseBindingMutation(value: unknown): DeviceBindingDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.employeeId !== 'string' ||
    typeof value.deviceName !== 'string' ||
    (value.status !== 'PENDING' && value.status !== 'APPROVED' && value.status !== 'REVOKED') ||
    typeof value.requestedAt !== 'string' ||
    !nullableString(value.approvedAt) ||
    !nullableString(value.revokedAt) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminAccountsApiError(502, 'INVALID_RESPONSE');
  }
  return {
    id: value.id,
    employeeId: value.employeeId,
    deviceName: value.deviceName,
    status: value.status,
    requestedAt: value.requestedAt,
    approvedAt: value.approvedAt,
    revokedAt: value.revokedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
