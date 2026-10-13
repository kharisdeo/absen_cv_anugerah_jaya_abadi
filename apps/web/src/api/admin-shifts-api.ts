import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';

export type WorkShiftDto = Readonly<{
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateToleranceMinutes: number;
  workDays: readonly number[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type ShiftWriteInput = Readonly<{
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateToleranceMinutes: number;
  workDays: readonly number[];
}>;

export type ShiftUpdateInput = Partial<ShiftWriteInput>;

export class AdminShiftsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan shift belum berhasil.',
    );
    this.name = 'AdminShiftsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  return hour <= 23 && minute <= 59 && second <= 59;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
  );
}

function parseShift(value: unknown): WorkShiftDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
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
    throw new AdminShiftsApiError(502, 'INVALID_RESPONSE');
  }
  return value as WorkShiftDto;
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
    ({ status, code, requestId }) => new AdminShiftsApiError(status, code, requestId),
  );
}

function parseArray(payload: unknown): readonly WorkShiftDto[] {
  if (!Array.isArray(payload)) throw new AdminShiftsApiError(502, 'INVALID_RESPONSE');
  return payload.map(parseShift);
}

const shiftsPath = '/admin/shifts';

export const adminShiftsApi = {
  async listShifts(signal?: AbortSignal): Promise<readonly WorkShiftDto[]> {
    const response = await send(shiftsPath, 'GET', signal ? { signal } : {});
    return parseArray(await readJson(response, 200));
  },

  async createShift(input: ShiftWriteInput): Promise<WorkShiftDto> {
    const response = await send(shiftsPath, 'POST', { body: input });
    return parseShift(await readJson(response, 201));
  },

  async updateShift(shiftId: string, input: ShiftUpdateInput): Promise<WorkShiftDto> {
    const response = await send(`${shiftsPath}/${encodeURIComponent(shiftId)}`, 'PATCH', {
      body: input,
    });
    return parseShift(await readJson(response, 200));
  },

  async deactivateShift(shiftId: string): Promise<WorkShiftDto> {
    const response = await send(`${shiftsPath}/${encodeURIComponent(shiftId)}/deactivate`, 'POST');
    const shift = parseShift(await readJson(response, 200));
    if (shift.isActive) throw new AdminShiftsApiError(502, 'INVALID_RESPONSE');
    return shift;
  },
};
