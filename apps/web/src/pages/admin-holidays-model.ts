import {
  adminHolidaysApi,
  type HolidayCreateInput,
  type HolidayDto,
  type HolidayUpdateInput,
} from '../api/admin-holidays-api.js';
import { adminStoresApi, type StoreDto } from '../api/admin-stores-api.js';

export type HolidayScopeFilter = 'all' | 'national' | string;
export type HolidayLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type HolidayMutationState = 'idle' | 'saving' | 'deleting';

export type AdminHolidaysSnapshot = Readonly<{
  holidays: readonly HolidayDto[];
  holidaysState: HolidayLoadState;
  holidaysError: unknown | null;
  stores: readonly StoreDto[];
  storesState: HolidayLoadState;
  storesError: unknown | null;
  mutation: HolidayMutationState;
  mutationError: unknown | null;
  pendingDelete: HolidayDto | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

const initialSnapshot: AdminHolidaysSnapshot = {
  holidays: [],
  holidaysState: 'idle',
  holidaysError: null,
  stores: [],
  storesState: 'idle',
  storesError: null,
  mutation: 'idle',
  mutationError: null,
  pendingDelete: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

function sortHolidays(holidays: readonly HolidayDto[]): readonly HolidayDto[] {
  return [...holidays].sort((first, second) => {
    const byDate = first.holidayDate.localeCompare(second.holidayDate);
    if (byDate !== 0) return byDate;
    const byScope = (first.storeId ?? '').localeCompare(second.storeId ?? '');
    return byScope !== 0 ? byScope : first.id.localeCompare(second.id);
  });
}

function matchesScope(holiday: HolidayDto, scope: HolidayScopeFilter): boolean {
  if (scope === 'all') return true;
  if (scope === 'national') return holiday.storeId === null;
  return holiday.storeId === scope;
}

function apiFilters(scope: HolidayScopeFilter) {
  if (scope === 'all') return {};
  if (scope === 'national') return { storeId: 'national' as const };
  return { storeId: scope };
}

export class AdminHolidaysModel {
  private snapshot: AdminHolidaysSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private holidaysRequestId = 0;
  private storesRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminHolidaysSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminHolidaysSnapshot => this.snapshot;

  private update(patch: Partial<AdminHolidaysSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async loadHolidays(scope: HolidayScopeFilter, signal?: AbortSignal): Promise<void> {
    const requestId = ++this.holidaysRequestId;
    this.update({ holidaysState: 'loading', holidaysError: null });
    try {
      const holidays = await adminHolidaysApi.listHolidays(apiFilters(scope), signal);
      if (signal?.aborted || requestId !== this.holidaysRequestId) return;
      this.update({
        holidays: sortHolidays(holidays),
        holidaysState: 'ready',
        holidaysError: null,
      });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.holidaysRequestId) return;
      this.update({ holidaysState: 'error', holidaysError: error });
    }
  }

  async loadStores(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.storesRequestId;
    this.update({ storesState: 'loading', storesError: null });
    try {
      const stores = await adminStoresApi.listStores(signal);
      if (signal?.aborted || requestId !== this.storesRequestId) return;
      this.update({ stores, storesState: 'ready', storesError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.storesRequestId) return;
      this.update({ storesState: 'error', storesError: error });
    }
  }

  clearMutationError(): void {
    this.update({ mutationError: null, confirmationError: null, notice: null });
  }

  async saveHoliday(
    holidayId: string | null,
    input: HolidayCreateInput | HolidayUpdateInput,
    scope: HolidayScopeFilter,
  ): Promise<boolean> {
    if (
      this.snapshot.mutation !== 'idle' ||
      this.snapshot.holidaysState !== 'ready' ||
      this.snapshot.storesState !== 'ready'
    ) {
      return false;
    }
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      const saved = holidayId
        ? await adminHolidaysApi.updateHoliday(holidayId, input as HolidayUpdateInput)
        : await adminHolidaysApi.createHoliday(input as HolidayCreateInput);
      const remaining = this.snapshot.holidays.filter((holiday) => holiday.id !== saved.id);
      const holidays = matchesScope(saved, scope) ? [...remaining, saved] : remaining;
      this.update({
        holidays: sortHolidays(holidays),
        mutation: 'idle',
        mutationError: null,
        notice: holidayId
          ? 'Perubahan hari libur berhasil disimpan.'
          : 'Hari libur berhasil ditambahkan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  requestDelete(holidayId: string): void {
    const holiday = this.snapshot.holidays.find((item) => item.id === holidayId);
    if (!holiday || this.snapshot.mutation !== 'idle') return;
    this.update({ pendingDelete: holiday, confirmationError: null, notice: null });
  }

  cancelDelete(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingDelete: null, confirmationError: null });
  }

  async confirmDelete(): Promise<boolean> {
    const holiday = this.snapshot.pendingDelete;
    if (!holiday || this.snapshot.confirmationBusy || this.snapshot.mutation !== 'idle')
      return false;
    this.update({ confirmationBusy: true, confirmationError: null, mutation: 'deleting' });
    try {
      await adminHolidaysApi.deleteHoliday(holiday.id);
      this.update({
        holidays: this.snapshot.holidays.filter((item) => item.id !== holiday.id),
        mutation: 'idle',
        pendingDelete: null,
        notice: 'Hari libur berhasil dihapus.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', confirmationError: error });
      return false;
    } finally {
      this.update({ confirmationBusy: false });
    }
  }
}
