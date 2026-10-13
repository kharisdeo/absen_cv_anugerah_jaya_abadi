import { describe, expect, it, vi } from 'vitest';

import { PrismaNotificationRepository } from '../../src/modules/notifications/prisma-repository.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000521';
const OTHER_OWNER_ID = '00000000-0000-4000-8000-000000000522';
const NOTIFICATION_ID = '00000000-0000-4000-8000-000000000523';
const CREATED_AT = new Date('2026-10-11T03:00:00.000Z');
const READ_AT = new Date('2026-10-11T04:00:00.000Z');

function unreadRow() {
  return {
    id: NOTIFICATION_ID,
    kind: 'ATTENDANCE_VERIFICATION',
    title: 'Absensi menunggu verifikasi',
    message: 'Ada absensi yang menunggu verifikasi.',
    readAt: null,
    createdAt: CREATED_AT,
  };
}

describe('PrismaNotificationRepository', () => {
  it('lists only the owner notifications and counts all unread rows in the same owner scope', async () => {
    const prisma = {
      notification: {
        findMany: vi.fn(async () => [unreadRow()]),
        count: vi.fn(async () => 4),
      },
    };
    const repository = new PrismaNotificationRepository(prisma as never);

    const result = await repository.list({
      userAccountId: OWNER_ID,
      read: 'UNREAD',
      skip: 10,
      take: 26,
    });

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userAccountId: OWNER_ID, readAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 26,
      select: {
        id: true,
        kind: true,
        title: true,
        message: true,
        readAt: true,
        createdAt: true,
      },
    });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userAccountId: OWNER_ID, readAt: null },
    });
    expect(result).toMatchObject({ items: [unreadRow()], unreadCount: 4, hasNextPage: false });
  });

  it('marks only the current owner row and returns the original timestamp on an idempotent retry', async () => {
    let storedReadAt: Date | null = null;
    const prisma = {
      notification: {
        updateMany: vi.fn(
          async (input: { where: Record<string, unknown>; data: { readAt: Date } }) => {
            if (
              input.where.id !== NOTIFICATION_ID ||
              input.where.userAccountId !== OWNER_ID ||
              input.where.readAt !== null ||
              storedReadAt !== null
            ) {
              return { count: 0 };
            }
            storedReadAt = input.data.readAt;
            return { count: 1 };
          },
        ),
        findFirst: vi.fn(async (input: { where: Record<string, unknown> }) => {
          if (input.where.id !== NOTIFICATION_ID || input.where.userAccountId !== OWNER_ID)
            return null;
          return { id: NOTIFICATION_ID, readAt: storedReadAt };
        }),
      },
    };
    const repository = new PrismaNotificationRepository(prisma as never);

    await expect(
      repository.markRead({ id: NOTIFICATION_ID, userAccountId: OWNER_ID, readAt: READ_AT }),
    ).resolves.toEqual({ id: NOTIFICATION_ID, readAt: READ_AT });
    await expect(
      repository.markRead({
        id: NOTIFICATION_ID,
        userAccountId: OWNER_ID,
        readAt: new Date('2026-10-11T05:00:00.000Z'),
      }),
    ).resolves.toEqual({ id: NOTIFICATION_ID, readAt: READ_AT });

    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: NOTIFICATION_ID, userAccountId: OWNER_ID, readAt: null },
      data: { readAt: READ_AT },
    });
    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userAccountId: OWNER_ID },
      select: { id: true, readAt: true },
    });
  });

  it('does not disclose whether another account owns a notification', async () => {
    const prisma = {
      notification: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async (input: { where: Record<string, unknown> }) => {
          expect(input.where.userAccountId).toBe(OTHER_OWNER_ID);
          return null;
        }),
      },
    };
    const repository = new PrismaNotificationRepository(prisma as never);

    await expect(
      repository.markRead({ id: NOTIFICATION_ID, userAccountId: OTHER_OWNER_ID, readAt: READ_AT }),
    ).resolves.toBeNull();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userAccountId: OTHER_OWNER_ID, readAt: null },
      data: { readAt: READ_AT },
    });
  });
});
