import { describe, expect, it } from 'vitest';

import type { HolidayDto } from '../src/api/admin-holidays-api.js';
import {
  emptyHolidayDraft,
  holidayInputDiff,
  holidayToDraft,
  NATIONAL_HOLIDAY_SCOPE,
  validateHolidayDraft,
} from '../src/pages/admin-holiday-form.js';

const holiday: HolidayDto = {
  id: '00000000-0000-4000-8000-000000000611',
  storeId: null,
  holidayDate: '2028-02-29',
  description: 'Libur nasional',
  createdAt: '2026-10-10T08:00:00.000Z',
};

describe('admin holiday form', () => {
  it('starts with no browser-derived date or scope', () => {
    expect(emptyHolidayDraft()).toEqual({ holidayDate: '', description: '', storeScope: '' });
  });

  it('accepts an explicitly selected leap date and maps national scope to null', () => {
    expect(
      validateHolidayDraft({
        holidayDate: '2028-02-29',
        description: '  Libur nasional  ',
        storeScope: NATIONAL_HOLIDAY_SCOPE,
      }),
    ).toEqual({
      errors: {},
      input: { storeId: null, holidayDate: '2028-02-29', description: 'Libur nasional' },
    });
  });

  it('rejects missing scope, blank description, and impossible calendar dates', () => {
    expect(
      validateHolidayDraft({ holidayDate: '2027-02-29', description: '  ', storeScope: '' }),
    ).toEqual({
      errors: {
        holidayDate: 'Pilih tanggal kalender yang valid.',
        description: 'Keterangan hari libur wajib diisi.',
        storeScope: 'Pilih cakupan nasional atau satu toko.',
      },
      input: null,
    });
  });

  it('maps a saved store scope and computes a minimal patch', () => {
    const storeHoliday = { ...holiday, storeId: '00000000-0000-4000-8000-000000000612' };
    expect(holidayToDraft(storeHoliday).storeScope).toBe(storeHoliday.storeId);
    expect(
      holidayInputDiff(holiday, {
        storeId: null,
        holidayDate: holiday.holidayDate,
        description: 'Keterangan diperbarui',
      }),
    ).toEqual({ description: 'Keterangan diperbarui' });
  });
});
