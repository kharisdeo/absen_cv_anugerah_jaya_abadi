import { describe, expect, it, vi } from 'vitest';

import type { StoreDto } from '../src/api/admin-stores-api.js';
import type {
  SystemDisruptionDto,
  SystemDisruptionPage,
} from '../src/api/system-disruptions-api.js';
import {
  canSubmitSystemDisruption,
  createEmptySystemDisruptionDraft,
  serializeWibDateTime,
  SystemDisruptionsModel,
  validateSystemDisruptionDraft,
} from '../src/pages/system-disruptions-model.js';

const storeId = '00000000-0000-4000-8000-000000000101';
const disruption: SystemDisruptionDto = {
  id: '00000000-0000-4000-8000-000000000102',
  storeId: null,
  startsAt: '2026-10-11T02:00:00.000Z',
  endsAt: '2026-10-11T04:00:00.000Z',
  reason: 'Gangguan koneksi pusat',
  isActive: true,
  createdAt: '2026-10-11T01:30:00.000Z',
  updatedAt: '2026-10-11T01:30:00.000Z',
};
const emptyPage: SystemDisruptionPage = {
  items: [],
  page: 1,
  pageSize: 25,
  hasNextPage: false,
};
const input = {
  storeId: null,
  startsAt: '2026-10-11T09:00:00+07:00',
  endsAt: '2026-10-11T11:00:00+07:00',
  reason: 'Gangguan koneksi pusat',
};

function store(): StoreDto {
  return {
    id: storeId,
    name: 'Toko Contoh',
    address: null,
    latitude: -6.2,
    longitude: 106.8,
    radiusMeters: 10,
    accuracyLimitMeters: 30,
    wifiPublicIp: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('system disruption form and model', () => {
  it('serializes datetime-local as explicit WIB independent of browser timezone and validates the period', () => {
    expect(serializeWibDateTime('2026-03-01T09:15')).toBe('2026-03-01T09:15:00+07:00');
    expect(Date.parse(serializeWibDateTime('2026-03-01T09:15')!)).toBe(
      Date.parse('2026-03-01T02:15:00Z'),
    );
    expect(serializeWibDateTime('2026-02-30T09:15')).toBeNull();
    expect(serializeWibDateTime('2026-03-01T25:15')).toBeNull();

    const draft = {
      ...createEmptySystemDisruptionDraft(),
      startsAtLocal: '2026-03-01T09:15',
      endsAtLocal: '2026-03-01T09:14',
      reason: '  Pemeliharaan jaringan  ',
    };
    const invalid = validateSystemDisruptionDraft(draft);
    expect(invalid.input).toBeNull();
    expect(invalid.errors.endsAtLocal).toContain('setelah');

    const valid = validateSystemDisruptionDraft({ ...draft, endsAtLocal: '2026-03-01T10:00' });
    expect(valid.input).toEqual({
      storeId: null,
      startsAt: '2026-03-01T09:15:00+07:00',
      endsAt: '2026-03-01T10:00:00+07:00',
      reason: 'Pemeliharaan jaringan',
    });
  });

  it('blocks concurrent POSTs even before React has time to redraw the disabled button', async () => {
    let resolveCreate!: (value: SystemDisruptionDto) => void;
    const create = vi.fn(
      () =>
        new Promise<SystemDisruptionDto>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const model = new SystemDisruptionsModel(
      { list: vi.fn().mockResolvedValue(emptyPage), create },
      { listStores: vi.fn().mockResolvedValue([store()]) },
    );

    const first = model.create(input);
    expect(canSubmitSystemDisruption(model.getSnapshot())).toBe(false);
    await expect(model.create(input)).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate(disruption);
    await expect(first).resolves.toBe(true);
    expect(model.getSnapshot().createNotice).toContain('berhasil dicatat');
  });

  it('keeps an ambiguous POST fail-closed even after page one and remaining pages are reviewed', async () => {
    const networkError = Object.assign(new Error('network timeout'), {
      status: 0,
      code: 'NETWORK_ERROR',
    });
    const create = vi.fn().mockRejectedValueOnce(networkError);
    const firstPage: SystemDisruptionPage = { ...emptyPage, hasNextPage: true };
    const secondPage: SystemDisruptionPage = { ...emptyPage, page: 2 };
    const list = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const model = new SystemDisruptionsModel(
      { list, create },
      { listStores: vi.fn().mockResolvedValue([store()]) },
    );

    await expect(model.create(input)).resolves.toBe(false);
    expect(model.getSnapshot().submissionOutcomeUncertain).toBe(true);
    expect(canSubmitSystemDisruption(model.getSnapshot())).toBe(false);
    await expect(model.create(input)).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);

    model.reviewUncertainOutcome();
    expect(model.getSnapshot().storeFilter).toBe('all');
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ page: 1, hasNextPage: true });
    expect(canSubmitSystemDisruption(model.getSnapshot())).toBe(false);
    model.goToPage(2);
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ page: 2, hasNextPage: false });
    expect(canSubmitSystemDisruption(model.getSnapshot())).toBe(false);
    await expect(model.create(input)).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('treats definite 4xx rejections as not stored instead of requiring timeout verification', async () => {
    const rejected = Object.assign(new Error('bad request'), {
      status: 400,
      code: 'INVALID_SYSTEM_DISRUPTION',
    });
    const create = vi.fn().mockRejectedValueOnce(rejected);
    const model = new SystemDisruptionsModel(
      { list: vi.fn().mockResolvedValue(emptyPage), create },
      { listStores: vi.fn().mockResolvedValue([store()]) },
    );

    await expect(model.create(input)).resolves.toBe(false);
    expect(model.getSnapshot().submissionOutcomeUncertain).toBe(false);
    expect(canSubmitSystemDisruption(model.getSnapshot())).toBe(true);
  });

  it('supports loading/error/empty states and uses only selected store filter in exact pagination', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(emptyPage);
    const model = new SystemDisruptionsModel(
      { list, create: vi.fn() },
      { listStores: vi.fn().mockResolvedValue([store()]) },
    );

    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', items: [], page: 1 });
    model.setStoreFilter(storeId);
    expect(model.getSnapshot().storeFilter).toBe(storeId);
    expect(await model.load()).toBe(false);
    expect(model.getSnapshot().status).toBe('error');
    model.requestRefresh();
    expect(await model.load()).toBe(true);
    expect(list.mock.calls[0]?.[0]).toEqual({ page: 1, pageSize: 25 });
    expect(list.mock.calls[1]?.[0]).toEqual({ storeId, page: 1, pageSize: 25 });
  });
});
