import { API_BASE_URL } from '../config.js';
import { isApiDateTime } from './api-contract.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';

export const NOTIFICATION_KINDS = [
  'ATTENDANCE_VERIFICATION',
  'ATTENDANCE_REQUEST',
  'REQUEST_DECISION',
  'CORRECTION_DECISION',
  'SYSTEM_DISRUPTION',
  'RECAP_CLOSED',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationReadFilter = 'ALL' | 'READ' | 'UNREAD';

export type NotificationDto = Readonly<{
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationListQuery = Readonly<{
  read: NotificationReadFilter;
  page: number;
  pageSize: number;
}>;

export type NotificationPage = Readonly<{
  items: readonly NotificationDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  unreadCount: number;
}>;

export class NotificationsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan notifikasi belum berhasil.',
    );
    this.name = 'NotificationsApiError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function invalidResponse(): NotificationsApiError {
  return new NotificationsApiError(502, 'INVALID_RESPONSE');
}

export function normalizeNotificationListQuery(value: unknown): NotificationListQuery {
  if (!isRecord(value) || !hasExactKeys(value, ['read', 'page', 'pageSize'])) {
    throw new TypeError('Parameter daftar notifikasi tidak valid.');
  }
  const { read, page, pageSize } = value;
  if (
    (read !== 'ALL' && read !== 'READ' && read !== 'UNREAD') ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  ) {
    throw new TypeError('Parameter daftar notifikasi tidak valid.');
  }
  return { read, page, pageSize };
}

function parseNotification(value: unknown): NotificationDto {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'kind', 'title', 'message', 'readAt', 'createdAt']) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.kind !== 'string' ||
    !NOTIFICATION_KINDS.includes(value.kind as NotificationKind) ||
    typeof value.title !== 'string' ||
    typeof value.message !== 'string' ||
    (value.readAt !== null && !isApiDateTime(value.readAt)) ||
    !isApiDateTime(value.createdAt)
  ) {
    throw invalidResponse();
  }
  return value as NotificationDto;
}

function parsePage(value: unknown, query: NotificationListQuery): NotificationPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage', 'unreadCount']) ||
    !Array.isArray(value.items) ||
    value.items.length > query.pageSize ||
    value.page !== query.page ||
    value.pageSize !== query.pageSize ||
    typeof value.hasNextPage !== 'boolean' ||
    typeof value.unreadCount !== 'number' ||
    !Number.isSafeInteger(value.unreadCount) ||
    value.unreadCount < 0
  ) {
    throw invalidResponse();
  }
  const items = value.items.map(parseNotification);
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw invalidResponse();
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    hasNextPage: value.hasNextPage,
    unreadCount: value.unreadCount,
  };
}

async function readJson(response: Response, expectedStatus: number): Promise<unknown> {
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new NotificationsApiError(status, code, requestId),
  );
}

export const notificationsApi = {
  async list(queryInput: unknown, signal?: AbortSignal): Promise<NotificationPage> {
    const query = normalizeNotificationListQuery(queryInput);
    const params = new URLSearchParams({
      read: query.read,
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    const response = await apiFetch(`${API_BASE_URL}/notifications?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    return parsePage(await readJson(response, 200), query);
  },

  async markRead(notificationId: string): Promise<Readonly<{ id: string; readAt: string }>> {
    if (!UUID_PATTERN.test(notificationId)) throw new TypeError('ID notifikasi tidak valid.');
    const response = await apiFetch(
      `${API_BASE_URL}/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: 'PATCH', headers: { Accept: 'application/json' } },
    );
    const payload = await readJson(response, 200);
    if (
      !isRecord(payload) ||
      !hasExactKeys(payload, ['id', 'readAt']) ||
      payload.id !== notificationId ||
      typeof payload.readAt !== 'string' ||
      !isApiDateTime(payload.readAt)
    ) {
      throw invalidResponse();
    }
    return { id: payload.id, readAt: payload.readAt };
  },
};
