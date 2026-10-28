import { isApiCalendarDate, isApiDateTime } from '../api/api-contract.js';
import { adminStoresApi, type StoreDto } from '../api/admin-stores-api.js';
import {
  systemDisruptionsApi,
  type SystemDisruptionCreateInput,
  type SystemDisruptionDto,
  type SystemDisruptionPage,
} from '../api/system-disruptions-api.js';

export const GLOBAL_STORE_VALUE = 'global';
export const BUSINESS_TIME_ZONE = 'Asia/Jakarta';
export const WIB_OFFSET = '+07:00';
export const SYSTEM_DISRUPTIONS_PAGE_SIZE = 25;

export type SystemDisruptionDraft = Readonly<{
  storeId: string;
  startsAtLocal: string;
  endsAtLocal: string;
  reason: string;
}>;

export type SystemDisruptionDraftField = keyof SystemDisruptionDraft;
export type SystemDisruptionDraftErrors = Partial<Record<SystemDisruptionDraftField, string>>;

export type SystemDisruptionsSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error';
  storesStatus: 'loading' | 'ready' | 'error';
  page: number;
  pageSize: number;
  storeFilter: string;
  items: readonly SystemDisruptionDto[];
  hasNextPage: boolean;
  stores: readonly StoreDto[];
  error: unknown | null;
  storesError: unknown | null;
  createError: unknown | null;
  createNotice: string | null;
  submitting: boolean;
  submissionOutcomeUncertain: boolean;
  refreshVersion: number;
}>;

type SystemDisruptionsClient = Pick<typeof systemDisruptionsApi, 'list' | 'create'>;
type StoresClient = Pick<typeof adminStoresApi, 'listStores'>;

type PendingSubmission = Readonly<{
  input: SystemDisruptionCreateInput;
  fingerprint: string;
  idempotencyKey: string;
}>;

const INITIAL_SNAPSHOT: SystemDisruptionsSnapshot = {
  status: 'loading',
  storesStatus: 'loading',
  page: 1,
  pageSize: SYSTEM_DISRUPTIONS_PAGE_SIZE,
  storeFilter: 'all',
  items: [],
  hasNextPage: false,
  stores: [],
  error: null,
  storesError: null,
  createError: null,
  createNotice: null,
  submitting: false,
  submissionOutcomeUncertain: false,
  refreshVersion: 0,
};

const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function serializeWibDateTime(value: string): string | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match || !isApiCalendarDate(match[1])) return null;
  const timestamp = `${match[1]}T${match[2]}:${match[3]}:00${WIB_OFFSET}`;
  return isApiDateTime(timestamp) ? timestamp : null;
}

export function validateSystemDisruptionDraft(draft: SystemDisruptionDraft): Readonly<{
  errors: SystemDisruptionDraftErrors;
  input: SystemDisruptionCreateInput | null;
}> {
  const errors: SystemDisruptionDraftErrors = {};
  const startsAt = serializeWibDateTime(draft.startsAtLocal);
  const endsAt = serializeWibDateTime(draft.endsAtLocal);
  const reason = draft.reason.trim();

  if (
    draft.storeId !== GLOBAL_STORE_VALUE &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      draft.storeId,
    )
  ) {
    errors.storeId = 'Pilih toko aktif atau cakupan global.';
  }
  if (!startsAt) errors.startsAtLocal = 'Masukkan tanggal dan waktu mulai yang valid.';
  if (!endsAt) errors.endsAtLocal = 'Masukkan tanggal dan waktu selesai yang valid.';
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.endsAtLocal = 'Waktu selesai harus setelah waktu mulai.';
  }
  if (
    !reason ||
    reason.length > 500 ||
    [...reason].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  ) {
    errors.reason =
      'Alasan wajib diisi, maksimal 500 karakter, dan tidak boleh berisi karakter kontrol.';
  }
  if (Object.keys(errors).length > 0 || !startsAt || !endsAt) return { errors, input: null };

  return {
    errors,
    input: {
      storeId: draft.storeId === GLOBAL_STORE_VALUE ? null : draft.storeId,
      startsAt,
      endsAt,
      reason,
    },
  };
}

export function canSubmitSystemDisruption(snapshot: SystemDisruptionsSnapshot): boolean {
  return !snapshot.submitting && !snapshot.submissionOutcomeUncertain;
}

export function isAmbiguousDisruptionCreateOutcome(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && (status === 0 || status >= 500);
}

export function createEmptySystemDisruptionDraft(): SystemDisruptionDraft {
  return { storeId: GLOBAL_STORE_VALUE, startsAtLocal: '', endsAtLocal: '', reason: '' };
}

export class SystemDisruptionsModel {
  private snapshot: SystemDisruptionsSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private listVersion = 0;
  private storesVersion = 0;
  private createInFlight = false;
  private pendingSubmission: PendingSubmission | null = null;
  private readonly client: SystemDisruptionsClient;
  private readonly storesClient: StoresClient;

  constructor(
    client: SystemDisruptionsClient = systemDisruptionsApi,
    storesClient: StoresClient = adminStoresApi,
  ) {
    this.client = client;
    this.storesClient = storesClient;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SystemDisruptionsSnapshot => this.snapshot;
  getServerSnapshot = (): SystemDisruptionsSnapshot => INITIAL_SNAPSHOT;

  private update(next: SystemDisruptionsSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  async load(signal?: AbortSignal): Promise<boolean> {
    const version = ++this.listVersion;
    const { page, pageSize, storeFilter } = this.snapshot;
    this.update({ ...this.snapshot, status: 'loading', error: null });
    try {
      const result: SystemDisruptionPage = await this.client.list(
        { ...(storeFilter === 'all' ? {} : { storeId: storeFilter }), page, pageSize },
        signal,
      );
      if (signal?.aborted || version !== this.listVersion) return false;
      this.update({
        ...this.snapshot,
        status: 'ready',
        ...result,
        error: null,
      });
      return true;
    } catch (error: unknown) {
      if (signal?.aborted || version !== this.listVersion) return false;
      this.update({ ...this.snapshot, status: 'error', error });
      return false;
    }
  }

  async loadStores(signal?: AbortSignal): Promise<boolean> {
    const version = ++this.storesVersion;
    this.update({ ...this.snapshot, storesStatus: 'loading', storesError: null });
    try {
      const stores = await this.storesClient.listStores(signal);
      if (signal?.aborted || version !== this.storesVersion) return false;
      this.update({ ...this.snapshot, storesStatus: 'ready', stores, storesError: null });
      return true;
    } catch (error: unknown) {
      if (signal?.aborted || version !== this.storesVersion) return false;
      this.update({ ...this.snapshot, storesStatus: 'error', storesError: error });
      return false;
    }
  }

  setStoreFilter(storeFilter: string): void {
    this.update({
      ...this.snapshot,
      storeFilter,
      page: 1,
      status: 'loading',
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  goToPage(page: number): void {
    const canGoBack = page === this.snapshot.page - 1 && page >= 1;
    const canGoForward = page === this.snapshot.page + 1 && this.snapshot.hasNextPage;
    if (!canGoBack && !canGoForward) return;
    this.update({
      ...this.snapshot,
      page,
      status: 'loading',
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  reviewUncertainOutcome(): void {
    if (!this.snapshot.submissionOutcomeUncertain || this.snapshot.submitting) return;
    this.update({
      ...this.snapshot,
      storeFilter: 'all',
      page: 1,
      status: 'loading',
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  requestRefresh(): void {
    this.update({
      ...this.snapshot,
      status: 'loading',
      error: null,
      refreshVersion: this.snapshot.refreshVersion + 1,
    });
  }

  async create(input: SystemDisruptionCreateInput): Promise<boolean> {
    if (this.createInFlight || !canSubmitSystemDisruption(this.snapshot)) return false;
    const normalizedInput = normalizeCreateInput(input);
    const fingerprint = JSON.stringify(normalizedInput);
    const idempotencyKey =
      this.pendingSubmission?.fingerprint === fingerprint
        ? this.pendingSubmission.idempotencyKey
        : globalThis.crypto.randomUUID();
    this.pendingSubmission = { input: normalizedInput, fingerprint, idempotencyKey };
    return this.submit(normalizedInput, idempotencyKey);
  }

  async retryUncertainCreate(): Promise<boolean> {
    if (
      this.createInFlight ||
      !this.snapshot.submissionOutcomeUncertain ||
      this.pendingSubmission === null
    ) {
      return false;
    }
    return this.submit(this.pendingSubmission.input, this.pendingSubmission.idempotencyKey);
  }

  private async submit(
    input: SystemDisruptionCreateInput,
    idempotencyKey: string,
  ): Promise<boolean> {
    this.createInFlight = true;
    this.update({
      ...this.snapshot,
      submitting: true,
      createError: null,
      createNotice: null,
    });
    try {
      await this.client.create(input, idempotencyKey);
      this.createInFlight = false;
      this.pendingSubmission = null;
      this.update({
        ...this.snapshot,
        submitting: false,
        submissionOutcomeUncertain: false,
        createError: null,
        createNotice: 'Gangguan berhasil dicatat. Daftar sedang diperbarui.',
        storeFilter: 'all',
        page: 1,
        refreshVersion: this.snapshot.refreshVersion + 1,
      });
      return true;
    } catch (error: unknown) {
      this.createInFlight = false;
      const outcomeUncertain = isAmbiguousDisruptionCreateOutcome(error);
      if (!outcomeUncertain) this.pendingSubmission = null;
      this.update({
        ...this.snapshot,
        submitting: false,
        submissionOutcomeUncertain: outcomeUncertain,
        createError: error,
        createNotice: null,
      });
      return false;
    }
  }
}

function normalizeCreateInput(input: SystemDisruptionCreateInput): SystemDisruptionCreateInput {
  return {
    storeId: input.storeId?.toLowerCase() ?? null,
    startsAt: new Date(input.startsAt).toISOString(),
    endsAt: new Date(input.endsAt).toISOString(),
    reason: input.reason.trim(),
  };
}
