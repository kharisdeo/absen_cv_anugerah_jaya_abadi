import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiErrorDetails, readApiJson } from './api-client.js';

export type StoreDto = Readonly<{
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
  wifiPublicIp: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type EmployeeOptionDto = Readonly<{
  id: string;
  nik: string;
  fullName: string;
  position: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  employmentDate: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type StoreAssignmentDto = Readonly<{
  storeId: string;
  employeeId: string;
  assignedByUserAccountId: string;
  assignedAt: string;
  employee: Readonly<{
    id: string;
    nik: string;
    fullName: string;
    status: 'ACTIVE' | 'INACTIVE';
  }>;
}>;

export type StoreWriteInput = Readonly<{
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
  wifiPublicIp: string | null;
}>;

export class AdminStoresApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan toko belum berhasil.',
    );
    this.name = 'AdminStoresApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseStore(value: unknown): StoreDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isNullableString(value.address) ||
    typeof value.latitude !== 'number' ||
    !Number.isFinite(value.latitude) ||
    typeof value.longitude !== 'number' ||
    !Number.isFinite(value.longitude) ||
    typeof value.radiusMeters !== 'number' ||
    !Number.isInteger(value.radiusMeters) ||
    typeof value.accuracyLimitMeters !== 'number' ||
    !Number.isInteger(value.accuracyLimitMeters) ||
    !isNullableString(value.wifiPublicIp) ||
    typeof value.isActive !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminStoresApiError(502, 'INVALID_RESPONSE');
  }
  return value as StoreDto;
}

function parseEmployee(value: unknown): EmployeeOptionDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.nik !== 'string' ||
    typeof value.fullName !== 'string' ||
    !isNullableString(value.position) ||
    (value.status !== 'ACTIVE' && value.status !== 'INACTIVE') ||
    !isNullableString(value.employmentDate) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminStoresApiError(502, 'INVALID_RESPONSE');
  }
  return value as EmployeeOptionDto;
}

function parseAssignment(value: unknown): StoreAssignmentDto {
  if (
    !isRecord(value) ||
    typeof value.storeId !== 'string' ||
    typeof value.employeeId !== 'string' ||
    typeof value.assignedByUserAccountId !== 'string' ||
    typeof value.assignedAt !== 'string' ||
    !isRecord(value.employee) ||
    typeof value.employee.id !== 'string' ||
    typeof value.employee.nik !== 'string' ||
    typeof value.employee.fullName !== 'string' ||
    (value.employee.status !== 'ACTIVE' && value.employee.status !== 'INACTIVE')
  ) {
    throw new AdminStoresApiError(502, 'INVALID_RESPONSE');
  }
  return value as StoreAssignmentDto;
}

async function send(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
    ({ status, code, requestId }) => new AdminStoresApiError(status, code, requestId),
  );
}

function parseArray<T>(payload: unknown, parseItem: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(payload)) throw new AdminStoresApiError(502, 'INVALID_RESPONSE');
  return payload.map(parseItem);
}

const storePath = '/admin/stores';

export const adminStoresApi = {
  async listStores(signal?: AbortSignal): Promise<readonly StoreDto[]> {
    const payload = await readJson(await send(storePath, 'GET', signal ? { signal } : {}), 200);
    return parseArray(payload, parseStore);
  },

  async createStore(input: StoreWriteInput): Promise<StoreDto> {
    const payload = await readJson(await send(storePath, 'POST', { body: input }), 201);
    return parseStore(payload);
  },

  async updateStore(storeId: string, input: StoreWriteInput): Promise<StoreDto> {
    const payload = await readJson(
      await send(`${storePath}/${encodeURIComponent(storeId)}`, 'PATCH', { body: input }),
      200,
    );
    return parseStore(payload);
  },

  async deactivateStore(storeId: string): Promise<StoreDto> {
    const payload = await readJson(
      await send(`${storePath}/${encodeURIComponent(storeId)}/deactivate`, 'POST'),
      200,
    );
    return parseStore(payload);
  },

  async listAssignments(
    storeId: string,
    signal?: AbortSignal,
  ): Promise<readonly StoreAssignmentDto[]> {
    const payload = await readJson(
      await send(
        `${storePath}/${encodeURIComponent(storeId)}/assignments`,
        'GET',
        signal ? { signal } : {},
      ),
      200,
    );
    return parseArray(payload, parseAssignment);
  },

  async assignEmployee(storeId: string, employeeId: string): Promise<StoreAssignmentDto> {
    const payload = await readJson(
      await send(
        `${storePath}/${encodeURIComponent(storeId)}/assignments/${encodeURIComponent(employeeId)}`,
        'PUT',
      ),
      200,
    );
    return parseAssignment(payload);
  },

  async removeEmployee(storeId: string, employeeId: string): Promise<void> {
    const response = await send(
      `${storePath}/${encodeURIComponent(storeId)}/assignments/${encodeURIComponent(employeeId)}`,
      'DELETE',
    );
    if (!response.ok) {
      const details = await readApiErrorDetails(response);
      throw new AdminStoresApiError(details.status, details.code, details.requestId);
    }
    if (response.status !== 204) throw new AdminStoresApiError(502, 'INVALID_RESPONSE');
  },

  async listEmployees(signal?: AbortSignal): Promise<readonly EmployeeOptionDto[]> {
    const payload = await readJson(
      await send('/admin/employees', 'GET', signal ? { signal } : {}),
      200,
    );
    return parseArray(payload, parseEmployee);
  },
};
