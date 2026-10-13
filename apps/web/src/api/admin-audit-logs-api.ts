import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';
import { isApiDateTime } from './api-contract.js';

export type AdminAuditLogItem = Readonly<{
  id: string;
  actorUserAccountId: string | null;
  occurredAt: string;
  clientIp: string | null;
  deviceIdHash: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData: Readonly<Record<string, unknown>> | null;
  afterData: Readonly<Record<string, unknown>> | null;
  reason: string | null;
  requestId: string | null;
}>;

export type AdminAuditLogQuery = Readonly<{
  actorUserAccountId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}>;

export type AdminAuditLogPage = Readonly<{
  items: readonly AdminAuditLogItem[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export class AdminAuditLogsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Audit log belum dapat dimuat.',
    );
    this.name = 'AdminAuditLogsApiError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;
const QUERY_KEYS = [
  'actorUserAccountId',
  'action',
  'entityType',
  'entityId',
  'from',
  'to',
  'page',
  'pageSize',
] as const;
const ITEM_KEYS = [
  'id',
  'actorUserAccountId',
  'occurredAt',
  'clientIp',
  'deviceIdHash',
  'action',
  'entityType',
  'entityId',
  'beforeData',
  'afterData',
  'reason',
  'requestId',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isNullableObject(value: unknown): value is Readonly<Record<string, unknown>> | null {
  return value === null || isRecord(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && isApiDateTime(value);
}

function invalidResponse(): AdminAuditLogsApiError {
  return new AdminAuditLogsApiError(502, 'INVALID_RESPONSE');
}

export function normalizeAdminAuditLogQuery(value: unknown): AdminAuditLogQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !QUERY_KEYS.includes(key as (typeof QUERY_KEYS)[number]))
  ) {
    throw new AdminAuditLogsApiError(400, 'INVALID_AUDIT_INPUT');
  }

  const { actorUserAccountId, action, entityType, entityId, from, to } = value;
  const page = value.page ?? 1;
  const pageSize = value.pageSize ?? 50;
  if (
    (actorUserAccountId !== undefined && !isUuid(actorUserAccountId)) ||
    (action !== undefined &&
      (typeof action !== 'string' ||
        action.length < 1 ||
        action.length > 100 ||
        !FILTER_TOKEN_PATTERN.test(action))) ||
    (entityType !== undefined &&
      (typeof entityType !== 'string' ||
        entityType.length < 1 ||
        entityType.length > 100 ||
        !FILTER_TOKEN_PATTERN.test(entityType))) ||
    (entityId !== undefined &&
      (typeof entityId !== 'string' || entityId.length < 1 || entityId.length > 128)) ||
    (from !== undefined && !isInstant(from)) ||
    (to !== undefined && !isInstant(to)) ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to))
  ) {
    throw new AdminAuditLogsApiError(400, 'INVALID_AUDIT_INPUT');
  }

  return {
    ...(actorUserAccountId === undefined ? {} : { actorUserAccountId }),
    ...(action === undefined ? {} : { action }),
    ...(entityType === undefined ? {} : { entityType }),
    ...(entityId === undefined ? {} : { entityId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    page,
    pageSize,
  };
}

function parseItem(value: unknown): AdminAuditLogItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ITEM_KEYS) ||
    !isUuid(value.id) ||
    !isNullableUuid(value.actorUserAccountId) ||
    !isInstant(value.occurredAt) ||
    !isNullableString(value.clientIp) ||
    !isNullableString(value.deviceIdHash) ||
    typeof value.action !== 'string' ||
    typeof value.entityType !== 'string' ||
    !isNullableString(value.entityId) ||
    !isNullableObject(value.beforeData) ||
    !isNullableObject(value.afterData) ||
    !isNullableString(value.reason) ||
    !isNullableUuid(value.requestId)
  ) {
    throw invalidResponse();
  }
  return value as AdminAuditLogItem;
}

function parsePage(value: unknown, query: AdminAuditLogQuery): AdminAuditLogPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage']) ||
    !Array.isArray(value.items) ||
    value.items.length > query.pageSize ||
    value.page !== query.page ||
    value.pageSize !== query.pageSize ||
    typeof value.hasNextPage !== 'boolean' ||
    (value.hasNextPage && value.items.length !== query.pageSize)
  ) {
    throw invalidResponse();
  }
  const items = value.items.map(parseItem);
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw invalidResponse();
  return { items, page: query.page, pageSize: query.pageSize, hasNextPage: value.hasNextPage };
}

export const adminAuditLogsApi = {
  async list(queryInput: unknown, signal?: AbortSignal): Promise<AdminAuditLogPage> {
    const query = normalizeAdminAuditLogQuery(queryInput);
    const params = new URLSearchParams();
    for (const key of QUERY_KEYS) {
      const value = query[key];
      if (value !== undefined) params.set(key, String(value));
    }
    const response = await apiFetch(`${API_BASE_URL}/admin/audit-logs?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    const payload = await readApiJson(
      response,
      200,
      ({ status, code, requestId }) => new AdminAuditLogsApiError(status, code, requestId),
    );
    return parsePage(payload, query);
  },
};
