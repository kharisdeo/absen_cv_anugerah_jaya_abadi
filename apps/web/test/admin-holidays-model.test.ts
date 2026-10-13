import { afterEach, describe, expect, it, vi } from 'vitest';

import { toUserErrorMessage } from '../src/api/error-message.js';
import {
  AdminHolidaysApiError,
  adminHolidaysApi,
  type HolidayDto,
} from '../src/api/admin-holidays-api.js';
import { adminStoresApi, type StoreDto } from '../src/api/admin-stores-api.js';
import { AdminHolidaysModel } from '../src/pages/admin-holidays-model.js';

const nationalHoliday: HolidayDto = {
  id: '00000000-0000-4000-8000-000000000641',
  storeId: null,
  holidayDate: '2028-02-29',
  description: 'Libur nasional',
  createdAt: '2026-10-10T08:00:00.000Z',
};
const storeId = '00000000-0000-4000-8000-000000000642';
const storeHoliday: HolidayDto = {
  ...nationalHoliday,
  id: '00000000-0000-4000-8000-000000000643',
  storeId,
  description: 'Libur toko',
};
const stores: readonly StoreDto[] = [
  {
    id: storeId,
    name: 'Toko Nonaktif',
    address: null,
    latitude: -6.2,
    longitude: 106.8,
    radiusMeters: 10,
    accuracyLimitMeters: 30,
    wifiPublicIp: null,
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => vi.restoreAllMocks());

async function readyModel(model: AdminHolidaysModel, scope: 'all' | 'national' | string = 'all') {
  vi.spyOn(adminHolidaysApi, 'listHolidays').mockResolvedValue([nationalHoliday, storeHoliday]);
  vi.spyOn(adminStoresApi, 'listStores').mockResolvedValue(stores);
  await Promise.all([model.loadHolidays(scope), model.loadStores()]);
}

describe('AdminHolidaysModel', () => {
  it('loads server records and all stores, including inactive store metadata', async () => {
    const model = new AdminHolidaysModel();
    await readyModel(model);

    expect(model.getSnapshot()).toMatchObject({
      holidaysState: 'ready',
      storesState: 'ready',
      holidays: [nationalHoliday, storeHoliday],
      stores,
    });
  });

  it('translates all, national, and store filters into exact API scopes', async () => {
    const listSpy = vi.spyOn(adminHolidaysApi, 'listHolidays').mockResolvedValue([]);
    const model = new AdminHolidaysModel();

    await model.loadHolidays('all');
    await model.loadHolidays('national');
    await model.loadHolidays(storeId);

    expect(listSpy).toHaveBeenNthCalledWith(1, {}, undefined);
    expect(listSpy).toHaveBeenNthCalledWith(2, { storeId: 'national' }, undefined);
    expect(listSpy).toHaveBeenNthCalledWith(3, { storeId }, undefined);
  });

  it('updates the local scope view only from a successful server DTO', async () => {
    const model = new AdminHolidaysModel();
    await readyModel(model);
    const created = {
      ...nationalHoliday,
      id: '00000000-0000-4000-8000-000000000644',
      holidayDate: '2028-03-01',
    };
    const createSpy = vi.spyOn(adminHolidaysApi, 'createHoliday').mockResolvedValue(created);

    await expect(
      model.saveHoliday(
        null,
        { storeId: null, holidayDate: '2028-03-01', description: 'Libur nasional' },
        'all',
      ),
    ).resolves.toBe(true);

    expect(createSpy).toHaveBeenCalledWith({
      storeId: null,
      holidayDate: '2028-03-01',
      description: 'Libur nasional',
    });
    expect(model.getSnapshot().holidays.map((item) => item.id)).toContain(created.id);
    expect(model.getSnapshot().mutation).toBe('idle');
  });

  it('keeps conflicting records unchanged and exposes only a safe allowlisted error', async () => {
    const model = new AdminHolidaysModel();
    await readyModel(model);
    vi.spyOn(adminHolidaysApi, 'createHoliday').mockRejectedValue(
      new AdminHolidaysApiError(409, 'HOLIDAY_DATE_CONFLICT'),
    );

    await expect(
      model.saveHoliday(
        null,
        { storeId: null, holidayDate: nationalHoliday.holidayDate, description: 'Duplikat' },
        'all',
      ),
    ).resolves.toBe(false);

    expect(model.getSnapshot().holidays).toEqual([nationalHoliday, storeHoliday]);
    expect(toUserErrorMessage(model.getSnapshot().mutationError)).toBe(
      'Hari libur untuk cakupan tersebut sudah terdaftar pada tanggal yang sama.',
    );
  });

  it('deletes only after a confirmation request and removes the record after 204 success', async () => {
    const model = new AdminHolidaysModel();
    await readyModel(model);
    const deleteSpy = vi.spyOn(adminHolidaysApi, 'deleteHoliday').mockResolvedValue();

    model.requestDelete(nationalHoliday.id);
    expect(model.getSnapshot().pendingDelete).toEqual(nationalHoliday);
    await expect(model.confirmDelete()).resolves.toBe(true);

    expect(deleteSpy).toHaveBeenCalledWith(nationalHoliday.id);
    expect(model.getSnapshot().holidays).toEqual([storeHoliday]);
    expect(model.getSnapshot().pendingDelete).toBeNull();
    expect(model.getSnapshot().notice).toBe('Hari libur berhasil dihapus.');
  });
});
