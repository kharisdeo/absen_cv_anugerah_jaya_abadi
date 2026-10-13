import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';
import { API_EMPLOYEE_STATUSES, type ApiEmployeeStatus } from './api-contract.js';

export type EmployeeStatus = ApiEmployeeStatus;

export type EmployeeDto = Readonly<{
  id: string;
  nik: string;
  fullName: string;
  position: string | null;
  status: EmployeeStatus;
  employmentDate: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type EmployeeProfileInput = Readonly<{
  nik: string;
  fullName: string;
  position: string | null;
  employmentDate: string | null;
}>;

export type EmployeeProfilePatch = Readonly<Partial<EmployeeProfileInput>>;

export class AdminEmployeesApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan profil karyawan belum berhasil.',
    );
    this.name = 'AdminEmployeesApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseEmployee(value: unknown): EmployeeDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.nik !== 'string' ||
    typeof value.fullName !== 'string' ||
    !isNullableString(value.position) ||
    typeof value.status !== 'string' ||
    !(API_EMPLOYEE_STATUSES as readonly string[]).includes(value.status) ||
    !isNullableString(value.employmentDate) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminEmployeesApiError(502, 'INVALID_RESPONSE');
  }
  return value as EmployeeDto;
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
    ({ status, code, requestId }) => new AdminEmployeesApiError(status, code, requestId),
  );
}

function parseEmployeeArray(payload: unknown): readonly EmployeeDto[] {
  if (!Array.isArray(payload)) throw new AdminEmployeesApiError(502, 'INVALID_RESPONSE');
  return payload.map(parseEmployee);
}

const employeePath = '/admin/employees';

export const adminEmployeesApi = {
  async listEmployees(signal?: AbortSignal): Promise<readonly EmployeeDto[]> {
    const response = await send(employeePath, 'GET', signal ? { signal } : {});
    return parseEmployeeArray(await readJson(response, 200));
  },

  async getEmployee(employeeId: string, signal?: AbortSignal): Promise<EmployeeDto> {
    const response = await send(
      `${employeePath}/${encodeURIComponent(employeeId)}`,
      'GET',
      signal ? { signal } : {},
    );
    return parseEmployee(await readJson(response, 200));
  },

  async createEmployee(input: EmployeeProfileInput): Promise<EmployeeDto> {
    const response = await send(employeePath, 'POST', { body: input });
    return parseEmployee(await readJson(response, 201));
  },

  async updateEmployee(employeeId: string, input: EmployeeProfilePatch): Promise<EmployeeDto> {
    const response = await send(`${employeePath}/${encodeURIComponent(employeeId)}`, 'PATCH', {
      body: input,
    });
    return parseEmployee(await readJson(response, 200));
  },

  async deactivateEmployee(employeeId: string): Promise<EmployeeDto> {
    const response = await send(
      `${employeePath}/${encodeURIComponent(employeeId)}/deactivate`,
      'POST',
    );
    return parseEmployee(await readJson(response, 200));
  },
};
