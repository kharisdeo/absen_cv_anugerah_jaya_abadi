import type { WorkShiftDto, ShiftWriteInput, ShiftUpdateInput } from '../api/admin-shifts-api.js';

export const ISO_WEEKDAYS = [
  { value: 1, label: 'Senin' },
  { value: 2, label: 'Selasa' },
  { value: 3, label: 'Rabu' },
  { value: 4, label: 'Kamis' },
  { value: 5, label: 'Jumat' },
  { value: 6, label: 'Sabtu' },
  { value: 7, label: 'Minggu' },
] as const;

export type ShiftDraft = Readonly<{
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: string;
  lateToleranceMinutes: string;
  workDays: readonly number[];
}>;

export type ShiftDraftField = keyof ShiftDraft;
export type ShiftDraftErrors = Partial<Record<ShiftDraftField, string>>;

export function emptyShiftDraft(): ShiftDraft {
  return {
    name: '',
    startTime: '',
    endTime: '',
    breakMinutes: '',
    lateToleranceMinutes: '',
    workDays: [],
  };
}

export function shiftToDraft(shift: WorkShiftDto): ShiftDraft {
  return {
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    breakMinutes: String(shift.breakMinutes),
    lateToleranceMinutes: String(shift.lateToleranceMinutes),
    workDays: [...shift.workDays].sort((first, second) => first - second),
  };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizeClockTime(value: string): string | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${match[1]}:${match[2]}:${String(second).padStart(2, '0')}`;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) return null;
  return parsed;
}

export function validateShiftDraft(draft: ShiftDraft): Readonly<{
  errors: ShiftDraftErrors;
  input: ShiftWriteInput | null;
}> {
  const errors: ShiftDraftErrors = {};
  const name = draft.name.trim();
  const startTime = normalizeClockTime(draft.startTime);
  const endTime = normalizeClockTime(draft.endTime);
  const breakMinutes = parseNonNegativeInteger(draft.breakMinutes);
  const lateToleranceMinutes = parseNonNegativeInteger(draft.lateToleranceMinutes);
  const workDays = [...draft.workDays];

  if (!name) errors.name = 'Nama shift wajib diisi.';
  else if (hasControlCharacters(name))
    errors.name = 'Nama shift tidak boleh berisi karakter kontrol.';

  if (startTime === null) errors.startTime = 'Masukkan jam mulai yang valid.';
  if (endTime === null) errors.endTime = 'Masukkan jam selesai yang valid.';
  if (startTime !== null && endTime !== null && startTime === endTime) {
    errors.endTime = 'Jam selesai harus berbeda dari jam mulai.';
  }

  if (breakMinutes === null) {
    errors.breakMinutes = 'Masukkan jumlah menit istirahat berupa bilangan bulat 0 atau lebih.';
  }
  if (lateToleranceMinutes === null) {
    errors.lateToleranceMinutes = 'Masukkan toleransi telat berupa bilangan bulat 0 atau lebih.';
  }

  if (workDays.length === 0) errors.workDays = 'Pilih minimal satu hari kerja.';
  else if (
    workDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(workDays).size !== workDays.length
  ) {
    errors.workDays = 'Hari kerja harus unik dan berada pada rentang Senin sampai Minggu.';
  }

  if (Object.keys(errors).length > 0 || breakMinutes === null || lateToleranceMinutes === null) {
    return { errors, input: null };
  }

  return {
    errors,
    input: {
      name,
      startTime: startTime!,
      endTime: endTime!,
      breakMinutes,
      lateToleranceMinutes,
      workDays: workDays.sort((first, second) => first - second),
    },
  };
}

export function shiftInputDiff(shift: WorkShiftDto, input: ShiftWriteInput): ShiftUpdateInput {
  const patch: {
    -readonly [Key in keyof ShiftWriteInput]?: ShiftWriteInput[Key];
  } = {};

  if (input.name !== shift.name) patch.name = input.name;
  if (normalizeClockTime(input.startTime) !== normalizeClockTime(shift.startTime)) {
    patch.startTime = input.startTime;
  }
  if (normalizeClockTime(input.endTime) !== normalizeClockTime(shift.endTime)) {
    patch.endTime = input.endTime;
  }
  if (input.breakMinutes !== shift.breakMinutes) patch.breakMinutes = input.breakMinutes;
  if (input.lateToleranceMinutes !== shift.lateToleranceMinutes) {
    patch.lateToleranceMinutes = input.lateToleranceMinutes;
  }

  const currentDays = [...shift.workDays].sort((first, second) => first - second);
  const nextDays = [...input.workDays].sort((first, second) => first - second);
  if (JSON.stringify(nextDays) !== JSON.stringify(currentDays)) patch.workDays = nextDays;
  return patch;
}

export function formatShiftTime(value: string): string {
  const normalized = normalizeClockTime(value);
  if (!normalized) return '—';
  return normalized.endsWith(':00') ? normalized.slice(0, 5) : normalized;
}

export function formatShiftMinutes(value: number): string {
  return `${value.toLocaleString('id-ID')} menit`;
}

export function formatShiftWorkDays(values: readonly number[]): string {
  const labels = new Map<number, string>(ISO_WEEKDAYS.map(({ value, label }) => [value, label]));
  return (
    [...values]
      .sort((first, second) => first - second)
      .map((value) => labels.get(value))
      .filter((label): label is string => label !== undefined)
      .join(', ') || '—'
  );
}
