import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiErrorDetails, readApiJson } from './api-client.js';
import { isApiDateTime } from './api-contract.js';

export type HolidayDto = Readonly<{
  id: string;
  storeId: string | null;
  holidayDate: string;
  description: string;
  createdAt: string;
}>;

export type HolidayListFilters = Readonly<{
  from?: string;
  to?: string;
  storeId?: 'national' | string;
}>;

export type HolidayCreateInput = Readonly<{
  storeId: string | null;
  holidayDate: string;
  description: string;
}>;

export type HolidayUpdateInput = Readonly<Partial<HolidayCreateInput>>;

export class AdminHolidaysApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengelolaan hari libur belum berhasil.',
    );
    this.name = 'AdminHolidaysApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isHolidayDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

const HOLIDAY_KEYS = ['createdAt', 'description', 'holidayDate', 'id', 'storeId'] as const;

function parseHoliday(value: unknown): HolidayDto {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== HOLIDAY_KEYS.length ||
    !HOLIDAY_KEYS.every((key) => Object.hasOwn(value, key)) ||
    !isUuid(value.id) ||
    !(value.storeId === null || isUuid(value.storeId)) ||
    !isHolidayDate(value.holidayDate) ||
    typeof value.description !== 'string' ||
    !isIsoInstant(value.createdAt)
  ) {
    throw new AdminHolidaysApiError(502, 'INVALID_RESPONSE');
  }
  return {
    id: value.id,
    storeId: value.storeId,
    holidayDate: value.holidayDate,
    description: value.description,
    createdAt: value.createdAt,
  };
}

async function send(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

async function readError(response: Response): Promise<AdminHolidaysApiError> {
  const details = await readApiErrorDetails(response);
  return new AdminHolidaysApiError(details.status, details.code, details.requestId);
}

async function readJson(response: Response, expectedStatus: number): Promise<unknown> {
  if (!response.ok) throw await readError(response);
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new AdminHolidaysApiError(status, code, requestId),
  );
}

function parseArray(value: unknown): readonly HolidayDto[] {
  if (!Array.isArray(value)) throw new AdminHolidaysApiError(502, 'INVALID_RESPONSE');
  return value.map(parseHoliday);
}

const holidaysPath = '/admin/holidays';

function holidayPath(holidayId: string): string {
  return `${holidaysPath}/${encodeURIComponent(holidayId)}`;
}

export const adminHolidaysApi = {
  async listHolidays(
    filters: HolidayListFilters = {},
    signal?: AbortSignal,
  ): Promise<readonly HolidayDto[]> {
    if (
      (filters.from !== undefined && !isHolidayDate(filters.from)) ||
      (filters.to !== undefined && !isHolidayDate(filters.to)) ||
      (filters.from !== undefined && filters.to !== undefined && filters.to < filters.from) ||
      (filters.storeId !== undefined && filters.storeId !== 'national' && !isUuid(filters.storeId))
    ) {
      throw new AdminHolidaysApiError(400, 'INVALID_SCHEDULE_INPUT');
    }
    const query = new URLSearchParams();
    if (filters.from !== undefined) query.set('from', filters.from);
    if (filters.to !== undefined) query.set('to', filters.to);
    if (filters.storeId !== undefined) query.set('storeId', filters.storeId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await send(`${holidaysPath}${suffix}`, 'GET', signal ? { signal } : {});
    return parseArray(await readJson(response, 200));
  },

  async createHoliday(input: HolidayCreateInput): Promise<HolidayDto> {
    const response = await send(holidaysPath, 'POST', { body: input });
    return parseHoliday(await readJson(response, 201));
  },

  async updateHoliday(holidayId: string, input: HolidayUpdateInput): Promise<HolidayDto> {
    if (Object.keys(input).length === 0) {
      throw new AdminHolidaysApiError(400, 'INVALID_SCHEDULE_INPUT');
    }
    const response = await send(holidayPath(holidayId), 'PATCH', { body: input });
    return parseHoliday(await readJson(response, 200));
  },

  async deleteHoliday(holidayId: string): Promise<void> {
    const response = await send(holidayPath(holidayId), 'DELETE');
    if (!response.ok) throw await readError(response);
    if (response.status !== 204) throw new AdminHolidaysApiError(502, 'INVALID_RESPONSE');
  },
};
