import { API_BASE_URL } from '../config.js';
import { isApiDateTime } from './api-contract.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';

export type SystemDisruptionDto = Readonly<{
  id: string;
  storeId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type SystemDisruptionQuery = Readonly<{
  storeId?: string;
  page: number;
  pageSize: number;
}>;

export type SystemDisruptionPage = Readonly<{
  items: readonly SystemDisruptionDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type SystemDisruptionCreateInput = Readonly<{
  storeId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}>;

export class SystemDisruptionsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan gangguan sistem belum berhasil.',
    );
    this.name = 'SystemDisruptionsApiError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DTO_KEYS = [
  'id',
  'storeId',
  'startsAt',
  'endsAt',
  'reason',
  'isActive',
  'createdAt',
  'updatedAt',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function invalidResponse(): SystemDisruptionsApiError {
  return new SystemDisruptionsApiError(502, 'INVALID_RESPONSE');
}

export function normalizeSystemDisruptionQuery(value: unknown): SystemDisruptionQuery {
  if (!isRecord(value)) throw new TypeError('Filter gangguan sistem tidak valid.');
  const allowed = ['storeId', 'page', 'pageSize'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Filter gangguan sistem tidak valid.');
  }
  const { storeId, page, pageSize } = value;
  if (
    (storeId !== undefined && (typeof storeId !== 'string' || !UUID_PATTERN.test(storeId))) ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  ) {
    throw new TypeError('Filter gangguan sistem tidak valid.');
  }
  return { ...(typeof storeId === 'string' ? { storeId } : {}), page, pageSize };
}

function parseDisruption(value: unknown): SystemDisruptionDto {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, DTO_KEYS) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    (value.storeId !== null &&
      (typeof value.storeId !== 'string' || !UUID_PATTERN.test(value.storeId))) ||
    typeof value.startsAt !== 'string' ||
    !isApiDateTime(value.startsAt) ||
    typeof value.endsAt !== 'string' ||
    !isApiDateTime(value.endsAt) ||
    Date.parse(value.endsAt) <= Date.parse(value.startsAt) ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length < 1 ||
    value.reason.trim().length > 500 ||
    typeof value.isActive !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    !isApiDateTime(value.createdAt) ||
    typeof value.updatedAt !== 'string' ||
    !isApiDateTime(value.updatedAt)
  ) {
    throw invalidResponse();
  }
  return value as SystemDisruptionDto;
}

function parsePage(value: unknown, query: SystemDisruptionQuery): SystemDisruptionPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage']) ||
    !Array.isArray(value.items) ||
    value.items.length > query.pageSize ||
    value.page !== query.page ||
    value.pageSize !== query.pageSize ||
    typeof value.hasNextPage !== 'boolean'
  ) {
    throw invalidResponse();
  }
  const items = value.items.map(parseDisruption);
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw invalidResponse();
  return { items, page: query.page, pageSize: query.pageSize, hasNextPage: value.hasNextPage };
}

function validateCreateInput(input: SystemDisruptionCreateInput): SystemDisruptionCreateInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['storeId', 'startsAt', 'endsAt', 'reason']) ||
    (input.storeId !== null &&
      (typeof input.storeId !== 'string' || !UUID_PATTERN.test(input.storeId))) ||
    typeof input.startsAt !== 'string' ||
    !isApiDateTime(input.startsAt) ||
    typeof input.endsAt !== 'string' ||
    !isApiDateTime(input.endsAt) ||
    Date.parse(input.endsAt) <= Date.parse(input.startsAt) ||
    typeof input.reason !== 'string' ||
    input.reason !== input.reason.trim() ||
    input.reason.length < 1 ||
    input.reason.length > 500 ||
    [...input.reason].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new TypeError('Data gangguan sistem tidak valid.');
  }
  return input;
}

async function readJson(response: Response, expectedStatus: number): Promise<unknown> {
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new SystemDisruptionsApiError(status, code, requestId),
  );
}

const path = `${API_BASE_URL}/admin/system-disruptions`;

export const systemDisruptionsApi = {
  async list(queryInput: unknown, signal?: AbortSignal): Promise<SystemDisruptionPage> {
    const query = normalizeSystemDisruptionQuery(queryInput);
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    if (query.storeId) params.set('storeId', query.storeId);
    const response = await apiFetch(`${path}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    return parsePage(await readJson(response, 200), query);
  },

  async create(input: SystemDisruptionCreateInput): Promise<SystemDisruptionDto> {
    const body = validateCreateInput(input);
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseDisruption(await readJson(response, 201));
  },
};
