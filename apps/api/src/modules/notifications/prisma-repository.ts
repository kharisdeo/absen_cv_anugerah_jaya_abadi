import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  NotificationReadFilter,
  NotificationRecord,
  NotificationRepository,
} from './index.js';

const notificationSelect = {
  id: true,
  kind: true,
  title: true,
  message: true,
  readAt: true,
  createdAt: true,
} as const;

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(input: {
    userAccountId: string;
    read: NotificationReadFilter;
    skip: number;
    take: number;
  }): Promise<{
    items: readonly NotificationRecord[];
    unreadCount: number;
    hasNextPage: boolean;
  }> {
    const readFilter =
      input.read === 'UNREAD'
        ? { readAt: null }
        : input.read === 'READ'
          ? { readAt: { not: null } }
          : {};
    const where = { userAccountId: input.userAccountId, ...readFilter };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: input.skip,
        take: input.take,
        select: notificationSelect,
      }),
      this.prisma.notification.count({
        where: { userAccountId: input.userAccountId, readAt: null },
      }),
    ]);
    return {
      items: rows,
      unreadCount,
      hasNextPage: rows.length === input.take,
    };
  }

  async markRead(input: { id: string; userAccountId: string; readAt: Date }) {
    const updated = await this.prisma.notification.updateMany({
      where: { id: input.id, userAccountId: input.userAccountId, readAt: null },
      data: { readAt: input.readAt },
    });
    if (updated.count === 1) return { id: input.id, readAt: input.readAt };

    const existing = await this.prisma.notification.findFirst({
      where: { id: input.id, userAccountId: input.userAccountId },
      select: { id: true, readAt: true },
    });
    return existing?.readAt ? { id: existing.id, readAt: existing.readAt } : null;
  }
}
