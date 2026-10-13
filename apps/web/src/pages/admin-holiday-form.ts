import {
  isHolidayDate,
  isUuid,
  type HolidayCreateInput,
  type HolidayDto,
} from '../api/admin-holidays-api.js';

export const NATIONAL_HOLIDAY_SCOPE = 'national';

export type HolidayDraft = Readonly<{
  holidayDate: string;
  description: string;
  storeScope: string;
}>;

export type HolidayDraftField = keyof HolidayDraft;

export type HolidayDraftErrors = Partial<Record<HolidayDraftField, string>>;

export function emptyHolidayDraft(): HolidayDraft {
  return { holidayDate: '', description: '', storeScope: '' };
}

export function holidayToDraft(holiday: HolidayDto): HolidayDraft {
  return {
    holidayDate: holiday.holidayDate,
    description: holiday.description,
    storeScope: holiday.storeId ?? NATIONAL_HOLIDAY_SCOPE,
  };
}

export function validateHolidayDraft(draft: HolidayDraft): Readonly<{
  errors: HolidayDraftErrors;
  input: HolidayCreateInput | null;
}> {
  const errors: HolidayDraftErrors = {};
  const description = draft.description.trim();

  if (!isHolidayDate(draft.holidayDate)) {
    errors.holidayDate = 'Pilih tanggal kalender yang valid.';
  }
  if (description.length === 0) {
    errors.description = 'Keterangan hari libur wajib diisi.';
  }
  if (draft.storeScope !== NATIONAL_HOLIDAY_SCOPE && !isUuid(draft.storeScope)) {
    errors.storeScope = 'Pilih cakupan nasional atau satu toko.';
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: {
      storeId: draft.storeScope === NATIONAL_HOLIDAY_SCOPE ? null : draft.storeScope,
      holidayDate: draft.holidayDate,
      description,
    },
  };
}

export function holidayInputDiff(
  holiday: HolidayDto,
  input: HolidayCreateInput,
): Readonly<Partial<HolidayCreateInput>> {
  return {
    ...(holiday.storeId === input.storeId ? {} : { storeId: input.storeId }),
    ...(holiday.holidayDate === input.holidayDate ? {} : { holidayDate: input.holidayDate }),
    ...(holiday.description === input.description ? {} : { description: input.description }),
  };
}
