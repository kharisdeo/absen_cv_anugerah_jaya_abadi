import {
  notificationsApi,
  type NotificationDto,
  type NotificationPage,
  type NotificationReadFilter,
} from '../api/notifications-api.js';

export type NotificationsSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error';
  readFilter: NotificationReadFilter;
  page: number;
  pageSize: number;
  items: readonly NotificationDto[];
  hasNextPage: boolean;
  unreadCount: number;
  error: unknown | null;
  actionError: unknown | null;
  busyNotificationId: string | null;
  refreshVersion: number;
}>;

type NotificationsClient = Pick<typeof notificationsApi, 'list' | 'markRead'>;

const INITIAL_SNAPSHOT: NotificationsSnapshot = {
  status: 'loading',
  readFilter: 'ALL',
  page: 1,
  pageSize: 25,
  items: [],
  hasNextPage: false,
  unreadCount: 0,
  error: null,
  actionError: null,
  busyNotificationId: null,
  refreshVersion: 0,
};

export class NotificationsModel {
  private snapshot: NotificationsSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private requestVersion = 0;
  private readonly client: NotificationsClient;

  constructor(client: NotificationsClient = notificationsApi) {
    this.client = client;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NotificationsSnapshot => this.snapshot;
  getServerSnapshot = (): NotificationsSnapshot => INITIAL_SNAPSHOT;

  private update(next: NotificationsSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  async load(signal?: AbortSignal): Promise<boolean> {
    const version = ++this.requestVersion;
    const { readFilter, page, pageSize } = this.snapshot;
    this.update({ ...this.snapshot, status: 'loading', error: null });
    try {
      const result: NotificationPage = await this.client.list(
        { read: readFilter, page, pageSize },
        signal,
      );
      if (signal?.aborted || version !== this.requestVersion) return false;
      this.update({ ...this.snapshot, status: 'ready', ...result, error: null });
      return true;
    } catch (error: unknown) {
      if (signal?.aborted || version !== this.requestVersion) return false;
      this.update({ ...this.snapshot, status: 'error', error });
      return false;
    }
  }

  setReadFilter(readFilter: NotificationReadFilter): void {
    if (readFilter === this.snapshot.readFilter) return;
    this.update({ ...this.snapshot, readFilter, page: 1, status: 'loading', error: null });
  }

  goToPage(page: number): void {
    const canGoBack = page === this.snapshot.page - 1 && page >= 1;
    const canGoForward = page === this.snapshot.page + 1 && this.snapshot.hasNextPage;
    if (!canGoBack && !canGoForward) return;
    this.update({ ...this.snapshot, page, status: 'loading', error: null });
  }

  requestRefresh(): void {
    this.update({
      ...this.snapshot,
      status: 'loading',
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  async markRead(notificationId: string): Promise<boolean> {
    if (this.snapshot.busyNotificationId !== null) return false;
    this.update({ ...this.snapshot, busyNotificationId: notificationId, actionError: null });
    try {
      await this.client.markRead(notificationId);
      this.update({
        ...this.snapshot,
        busyNotificationId: null,
        status: 'loading',
        refreshVersion: this.snapshot.refreshVersion + 1,
      });
      return true;
    } catch (error: unknown) {
      this.update({ ...this.snapshot, busyNotificationId: null, actionError: error });
      return false;
    }
  }
}
