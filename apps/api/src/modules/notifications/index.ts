import { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';

export type NotificationReadFilter = 'ALL' | 'READ' | 'UNREAD';

export type NotificationRecord = Readonly<{
  id: string;
  kind: string;
  title: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}>;

export type NotificationDto = Readonly<{
  id: string;
  kind: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationPage = Readonly<{
  items: readonly NotificationDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  unreadCount: number;
}>;

export type NotificationPageFilter = Readonly<{
  read: NotificationReadFilter;
  page?: number;
  pageSize?: number;
}>;

export interface NotificationRepository {
  list(
    input: Readonly<{
      userAccountId: string;
      read: NotificationReadFilter;
      skip: number;
      take: number;
    }>,
  ): Promise<
    Readonly<{
      items: readonly NotificationRecord[];
      unreadCount: number;
      hasNextPage: boolean;
    }>
  >;
  markRead(input: Readonly<{ id: string; userAccountId: string; readAt: Date }>): Promise<{
    id: string;
    readAt: Date;
  } | null>;
}

function invalidInput(message: string): AppError {
  return new AppError(400, 'INVALID_NOTIFICATION_INPUT', message);
}

function assertAuthenticatedActor(principal: AuthPrincipal): string {
  if (
    principal.role !== UserRole.ADMIN &&
    principal.role !== UserRole.SUPERVISOR &&
    principal.role !== UserRole.EMPLOYEE
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Notifikasi hanya dapat dibaca oleh akun terkait.');
  }
  return principal.userAccountId;
}

function normalizePage(filter: NotificationPageFilter): { page: number; pageSize: number } {
  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw invalidInput('Nomor halaman notifikasi tidak valid.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw invalidInput('Ukuran halaman notifikasi harus 1 sampai 50.');
  }
  return { page, pageSize };
}

function toDto(row: NotificationRecord): NotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    message: row.message,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    principal: AuthPrincipal,
    filter: NotificationPageFilter = { read: 'ALL' },
  ): Promise<NotificationPage> {
    const userAccountId = assertAuthenticatedActor(principal);
    if (filter.read !== 'ALL' && filter.read !== 'READ' && filter.read !== 'UNREAD') {
      throw invalidInput('Filter status notifikasi tidak valid.');
    }
    const { page, pageSize } = normalizePage(filter);
    const result = await this.repository.list({
      userAccountId,
      read: filter.read,
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
    });
    return {
      items: result.items.slice(0, pageSize).map(toDto),
      page,
      pageSize,
      hasNextPage: result.hasNextPage || result.items.length > pageSize,
      unreadCount: result.unreadCount,
    };
  }

  async markRead(
    principal: AuthPrincipal,
    notificationId: string,
  ): Promise<Readonly<{ id: string; readAt: string }>> {
    const userAccountId = assertAuthenticatedActor(principal);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notificationId)) {
      throw invalidInput('ID notifikasi tidak valid.');
    }
    const readAt = this.now();
    if (!Number.isFinite(readAt.getTime())) {
      throw new AppError(503, 'INTERNAL_SERVER_ERROR', 'Waktu server tidak tersedia.');
    }
    const result = await this.repository.markRead({ id: notificationId, userAccountId, readAt });
    if (!result) {
      throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
    }
    return { id: result.id, readAt: result.readAt.toISOString() };
  }
}
