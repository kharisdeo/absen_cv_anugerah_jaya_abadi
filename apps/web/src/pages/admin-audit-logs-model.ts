import { isApiCalendarDate } from '../api/api-contract.js';
import {
  adminAuditLogsApi,
  type AdminAuditLogItem,
  type AdminAuditLogPage,
  type AdminAuditLogQuery,
} from '../api/admin-audit-logs-api.js';

export const ADMIN_AUDIT_LOGS_PAGE_SIZE = 50;
export const AUDIT_LOGS_TIME_ZONE = 'Asia/Jakarta';
export const AUDIT_LOGS_WIB_OFFSET = '+07:00';

export type AdminAuditLogFilters = Readonly<{
  actorUserAccountId: string;
  action: string;
  entityType: string;
  entityId: string;
  fromDate: string;
  toDate: string;
}>;

export type AdminAuditLogsSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error';
  filters: AdminAuditLogFilters;
  page: number;
  pageSize: number;
  items: readonly AdminAuditLogItem[];
  hasNextPage: boolean;
  error: unknown | null;
  filterError: string | null;
  refreshVersion: number;
}>;

type AdminAuditLogsClient = Pick<typeof adminAuditLogsApi, 'list'>;

export const EMPTY_ADMIN_AUDIT_LOG_FILTERS: AdminAuditLogFilters = {
  actorUserAccountId: '',
  action: '',
  entityType: '',
  entityId: '',
  fromDate: '',
  toDate: '',
};

const INITIAL_SNAPSHOT: AdminAuditLogsSnapshot = {
  status: 'loading',
  filters: EMPTY_ADMIN_AUDIT_LOG_FILTERS,
  page: 1,
  pageSize: ADMIN_AUDIT_LOGS_PAGE_SIZE,
  items: [],
  hasNextPage: false,
  error: null,
  filterError: null,
  refreshVersion: 0,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;

function normalizeFilters(filters: AdminAuditLogFilters): AdminAuditLogFilters {
  return {
    actorUserAccountId: filters.actorUserAccountId.trim(),
    action: filters.action.trim(),
    entityType: filters.entityType.trim(),
    entityId: filters.entityId.trim(),
    fromDate: filters.fromDate,
    toDate: filters.toDate,
  };
}

function validateFilters(filters: AdminAuditLogFilters): string | null {
  if (filters.actorUserAccountId && !UUID_PATTERN.test(filters.actorUserAccountId)) {
    return 'Masukkan UUID akun aktor yang valid.';
  }
  if (
    filters.action &&
    (filters.action.length > 100 || !FILTER_TOKEN_PATTERN.test(filters.action))
  ) {
    return 'Filter aksi harus 1–100 karakter: huruf, angka, titik, garis bawah, titik dua, atau tanda hubung.';
  }
  if (
    filters.entityType &&
    (filters.entityType.length > 100 || !FILTER_TOKEN_PATTERN.test(filters.entityType))
  ) {
    return 'Filter jenis entitas harus 1–100 karakter: huruf, angka, titik, garis bawah, titik dua, atau tanda hubung.';
  }
  if (filters.entityId && filters.entityId.length > 128) {
    return 'ID entitas maksimal 128 karakter.';
  }
  if (filters.fromDate && !isApiCalendarDate(filters.fromDate)) {
    return 'Tanggal awal tidak valid.';
  }
  if (filters.toDate && !isApiCalendarDate(filters.toDate)) {
    return 'Tanggal akhir tidak valid.';
  }
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) {
    return 'Tanggal awal tidak boleh melewati tanggal akhir.';
  }
  return null;
}

function sameFilters(left: AdminAuditLogFilters, right: AdminAuditLogFilters): boolean {
  return (
    left.actorUserAccountId === right.actorUserAccountId &&
    left.action === right.action &&
    left.entityType === right.entityType &&
    left.entityId === right.entityId &&
    left.fromDate === right.fromDate &&
    left.toDate === right.toDate
  );
}

function toQuery(
  filters: AdminAuditLogFilters,
  page: number,
  pageSize: number,
): AdminAuditLogQuery {
  return {
    ...(filters.actorUserAccountId ? { actorUserAccountId: filters.actorUserAccountId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.fromDate
      ? { from: `${filters.fromDate}T00:00:00.000${AUDIT_LOGS_WIB_OFFSET}` }
      : {}),
    ...(filters.toDate ? { to: `${filters.toDate}T23:59:59.999${AUDIT_LOGS_WIB_OFFSET}` } : {}),
    page,
    pageSize,
  };
}

export class AdminAuditLogsModel {
  private snapshot: AdminAuditLogsSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private requestVersion = 0;
  private activeLoad: Readonly<{
    key: string;
    version: number;
    controller: AbortController;
    promise: Promise<boolean>;
  }> | null = null;
  private readonly client: AdminAuditLogsClient;

  constructor(client: AdminAuditLogsClient = adminAuditLogsApi) {
    this.client = client;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AdminAuditLogsSnapshot => this.snapshot;
  getServerSnapshot = (): AdminAuditLogsSnapshot => INITIAL_SNAPSHOT;

  private update(next: AdminAuditLogsSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private invalidateActiveLoad(): void {
    this.requestVersion += 1;
    this.activeLoad?.controller.abort();
    this.activeLoad = null;
  }

  setFilters(input: AdminAuditLogFilters): boolean {
    const filters = normalizeFilters(input);
    const filterError = validateFilters(filters);
    if (filterError) {
      this.update({ ...this.snapshot, filterError });
      return false;
    }
    if (sameFilters(filters, this.snapshot.filters) && this.snapshot.filterError === null)
      return false;

    this.invalidateActiveLoad();
    this.update({
      ...this.snapshot,
      filters,
      page: 1,
      status: 'loading',
      items: [],
      hasNextPage: false,
      error: null,
      filterError: null,
    });
    return true;
  }

  goToPage(page: number): void {
    const canGoBack = page === this.snapshot.page - 1 && page >= 1;
    const canGoForward = page === this.snapshot.page + 1 && this.snapshot.hasNextPage;
    if (this.snapshot.status !== 'ready' || (!canGoBack && !canGoForward)) return;
    this.invalidateActiveLoad();
    this.update({
      ...this.snapshot,
      page,
      status: 'loading',
      items: [],
      hasNextPage: false,
      error: null,
    });
  }

  requestRefresh(): void {
    this.invalidateActiveLoad();
    this.update({
      ...this.snapshot,
      status: 'loading',
      items: [],
      hasNextPage: false,
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  cancelLoad(): void {
    if (!this.activeLoad) return;
    this.invalidateActiveLoad();
  }

  load(): Promise<boolean> {
    const query = toQuery(this.snapshot.filters, this.snapshot.page, this.snapshot.pageSize);
    const key = JSON.stringify(query);
    if (this.activeLoad?.key === key && !this.activeLoad.controller.signal.aborted) {
      return this.activeLoad.promise;
    }

    this.invalidateActiveLoad();
    const version = ++this.requestVersion;
    const controller = new AbortController();
    this.update({ ...this.snapshot, status: 'loading', error: null });

    const promise = (async () => {
      try {
        const result: AdminAuditLogPage = await this.client.list(query, controller.signal);
        if (controller.signal.aborted || version !== this.requestVersion) return false;
        this.update({
          ...this.snapshot,
          status: 'ready',
          items: result.items,
          page: result.page,
          pageSize: result.pageSize,
          hasNextPage: result.hasNextPage,
          error: null,
        });
        return true;
      } catch (error: unknown) {
        if (controller.signal.aborted || version !== this.requestVersion) return false;
        this.update({ ...this.snapshot, status: 'error', error });
        return false;
      } finally {
        if (this.activeLoad?.version === version) this.activeLoad = null;
      }
    })();

    this.activeLoad = { key, version, controller, promise };
    return promise;
  }
}
