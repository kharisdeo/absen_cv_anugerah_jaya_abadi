import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeNotificationListQuery,
  NotificationsApiError,
  notificationsApi,
} from '../src/api/notifications-api.js';

const notification = {
  id: '00000000-0000-4000-8000-000000000101',
  kind: 'ATTENDANCE_REQUEST',
  title: 'Pengajuan baru',
  message: 'Ada pengajuan yang perlu diperiksa.',
  readAt: null,
  createdAt: '2026-10-11T08:15:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('notifications API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends the exact read filter and pagination with cookie credentials, no-store, and abort signal', async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [notification],
        page: 2,
        pageSize: 10,
        hasNextPage: false,
        unreadCount: 3,
      }),
    );

    await expect(
      notificationsApi.list({ read: 'UNREAD', page: 2, pageSize: 10 }, signal),
    ).resolves.toMatchObject({
      items: [notification],
      page: 2,
      unreadCount: 3,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/notifications?read=UNREAD&page=2&pageSize=10',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store', signal }),
    );
  });

  it('strictly validates list query and response DTOs, enum, pagination, timestamps, and unexpected fields', async () => {
    for (const query of [
      { read: 'ARCHIVED', page: 1, pageSize: 25 },
      { read: 'ALL', page: 0, pageSize: 25 },
      { read: 'ALL', page: 1, pageSize: 51 },
      { read: 'ALL', page: 1, pageSize: 25, employeeId: 'not-allowed' },
    ]) {
      expect(() => normalizeNotificationListQuery(query)).toThrow(TypeError);
    }

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...notification, kind: 'UNKNOWN_KIND' }],
        page: 1,
        pageSize: 25,
        hasNextPage: false,
        unreadCount: 0,
      }),
    );
    await expect(
      notificationsApi.list({ read: 'ALL', page: 1, pageSize: 25 }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<NotificationsApiError>);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...notification, createdAt: '2026-10-11T08:15:00' }],
        page: 1,
        pageSize: 25,
        hasNextPage: false,
        unreadCount: 0,
      }),
    );
    await expect(
      notificationsApi.list({ read: 'ALL', page: 1, pageSize: 25 }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...notification, userAccountId: 'private-field' }],
        page: 1,
        pageSize: 25,
        hasNextPage: false,
        unreadCount: 0,
      }),
    );
    await expect(
      notificationsApi.list({ read: 'ALL', page: 1, pageSize: 25 }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('marks only the requested notification read through the idempotent PATCH contract', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: notification.id, readAt: '2026-10-11T08:20:00.000Z' }),
    );

    await expect(notificationsApi.markRead(notification.id)).resolves.toEqual({
      id: notification.id,
      readAt: '2026-10-11T08:20:00.000Z',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/notifications/${notification.id}/read`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', credentials: 'include', cache: 'no-store' }),
    );
  });
});
