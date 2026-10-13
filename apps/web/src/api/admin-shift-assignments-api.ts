import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';

import type { EmployeeStatus } from './admin-employees-api.js';
import type { WorkShiftDto } from './admin-shifts-api.js';

export type ShiftAssignmentEmployeeDto = Readonly<{
  id: string;
  nik: string;
  fullName: string;
  status: EmployeeStatus;
}>;

export type ShiftAssignmentDto = Readonly<{
  id: string;
  employeeId: string;
  workShiftId: string;
  storeId: string | null;
  assignedByUserAccountId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  employee: ShiftAssignmentEmployeeDto;
  workShift: WorkShiftDto;
}>;

export type ShiftAssignmentFilters = Readonly<{
  employeeId?: string;
  storeId?: 'global' | string;
  businessDate?: string;
}>;

export type ShiftAssignmentCreateInput = Readonly<{
  employeeId: string;
  workShiftId: string;
  storeId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}>;

export type ShiftAssignmentUpdateInput = Readonly<{
  workShiftId?: string;
  storeId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}>;

export class AdminShiftAssignmentsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan penugasan shift belum berhasil.',
    );
    this.name = 'AdminShiftAssignmentsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3] ?? '0') <= 59;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseShift(value: unknown): WorkShiftDto {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    typeof value.name !== 'string' ||
    !isClockTime(value.startTime) ||
    !isClockTime(value.endTime) ||
    !isNonNegativeInteger(value.breakMinutes) ||
    !isNonNegativeInteger(value.lateToleranceMinutes) ||
    !Array.isArray(value.workDays) ||
    value.workDays.length === 0 ||
    value.workDays.some(
      (day) => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7,
    ) ||
    new Set(value.workDays).size !== value.workDays.length ||
    typeof value.isActive !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new AdminShiftAssignmentsApiError(502, 'INVALID_RESPONSE');
  }
  return value as WorkShiftDto;
}

function parseAssignment(value: unknown): ShiftAssignmentDto {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !isUuid(value.employeeId) ||
    !isUuid(value.workShiftId) ||
    !(value.storeId === null || isUuid(value.storeId)) ||
    !isNullableString(value.assignedByUserAccountId) ||
    !isDateOnly(value.effectiveFrom) ||
    !(value.effectiveTo === null || isDateOnly(value.effectiveTo)) ||
    typeof value.createdAt !== 'string' ||
    !isRecord(value.employee) ||
    !isUuid(value.employee.id) ||
    typeof value.employee.nik !== 'string' ||
    typeof value.employee.fullName !== 'string' ||
    (value.employee.status !== 'ACTIVE' && value.employee.status !== 'INACTIVE')
  ) {
    throw new AdminShiftAssignmentsApiError(502, 'INVALID_RESPONSE');
  }

  const workShift = parseShift(value.workShift);
  if (value.employee.id !== value.employeeId || workShift.id !== value.workShiftId) {
    throw new AdminShiftAssignmentsApiError(502, 'INVALID_RESPONSE');
  }

  return { ...value, workShift } as ShiftAssignmentDto;
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
    ({ status, code, requestId }) => new AdminShiftAssignmentsApiError(status, code, requestId),
  );
}

function parseArray(payload: unknown): readonly ShiftAssignmentDto[] {
  if (!Array.isArray(payload)) throw new AdminShiftAssignmentsApiError(502, 'INVALID_RESPONSE');
  return payload.map(parseAssignment);
}

const assignmentsPath = '/admin/shift-assignments';

function assignmentPath(assignmentId: string): string {
  return `${assignmentsPath}/${encodeURIComponent(assignmentId)}`;
}

export const adminShiftAssignmentsApi = {
  async listAssignments(
    filters: ShiftAssignmentFilters = {},
    signal?: AbortSignal,
  ): Promise<readonly ShiftAssignmentDto[]> {
    const query = new URLSearchParams();
    if (filters.employeeId !== undefined) query.set('employeeId', filters.employeeId);
    if (filters.storeId !== undefined) query.set('storeId', filters.storeId);
    if (filters.businessDate !== undefined) query.set('businessDate', filters.businessDate);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await send(`${assignmentsPath}${suffix}`, 'GET', signal ? { signal } : {});
    return parseArray(await readJson(response, 200));
  },

  async createAssignment(input: ShiftAssignmentCreateInput): Promise<ShiftAssignmentDto> {
    const response = await send(assignmentsPath, 'POST', { body: input });
    return parseAssignment(await readJson(response, 201));
  },

  async updateAssignment(
    assignmentId: string,
    input: ShiftAssignmentUpdateInput,
  ): Promise<ShiftAssignmentDto> {
    if (Object.keys(input).length === 0) {
      throw new AdminShiftAssignmentsApiError(400, 'INVALID_SCHEDULE_INPUT');
    }
    const response = await send(assignmentPath(assignmentId), 'PATCH', { body: input });
    return parseAssignment(await readJson(response, 200));
  },

  async deactivateAssignment(
    assignmentId: string,
    effectiveTo: string,
  ): Promise<ShiftAssignmentDto> {
    const response = await send(`${assignmentPath(assignmentId)}/deactivate`, 'POST', {
      body: { effectiveTo },
    });
    const assignment = parseAssignment(await readJson(response, 200));
    if (assignment.effectiveTo !== effectiveTo) {
      throw new AdminShiftAssignmentsApiError(502, 'INVALID_RESPONSE');
    }
    return assignment;
  },
};
