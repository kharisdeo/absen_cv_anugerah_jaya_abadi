import { describe, expect, it } from 'vitest';

import type { WorkShiftDto } from '../src/api/admin-shifts-api.js';
import {
  emptyShiftDraft,
  formatShiftTime,
  formatShiftWorkDays,
  shiftInputDiff,
  shiftToDraft,
  validateShiftDraft,
} from '../src/pages/admin-shift-form.js';

const shift: WorkShiftDto = {
  id: '00000000-0000-4000-8000-000000000401',
  name: 'Shift Pagi',
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  lateToleranceMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('admin shift form', () => {
  it('requires all catalog data and normalizes valid values to the API shape', () => {
    expect(validateShiftDraft(emptyShiftDraft()).input).toBeNull();

    const result = validateShiftDraft({
      name: '  Shift Siang  ',
      startTime: '13:00',
      endTime: '21:00',
      breakMinutes: '45',
      lateToleranceMinutes: '0',
      workDays: [5, 1, 3],
    });

    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      name: 'Shift Siang',
      startTime: '13:00:00',
      endTime: '21:00:00',
      breakMinutes: 45,
      lateToleranceMinutes: 0,
      workDays: [1, 3, 5],
    });
  });

  it('rejects same/invalid times, negative or fractional minutes, and invalid weekdays', () => {
    const result = validateShiftDraft({
      name: 'Shift',
      startTime: '25:00',
      endTime: '25:00',
      breakMinutes: '-1',
      lateToleranceMinutes: '1.5',
      workDays: [1, 1, 8],
    });

    expect(result.input).toBeNull();
    expect(result.errors.startTime).toBeDefined();
    expect(result.errors.endTime).toBeDefined();
    expect(result.errors.breakMinutes).toBeDefined();
    expect(result.errors.lateToleranceMinutes).toBeDefined();
    expect(result.errors.workDays).toBeDefined();
  });

  it('builds a minimal semantic patch and handles server time precision for the form', () => {
    const draft = shiftToDraft(shift);
    const unchanged = validateShiftDraft(draft);
    expect(unchanged.input).not.toBeNull();
    expect(shiftInputDiff(shift, unchanged.input!)).toEqual({});

    const changed = validateShiftDraft({ ...draft, breakMinutes: '30' });
    expect(changed.input).not.toBeNull();
    expect(shiftInputDiff(shift, changed.input!)).toEqual({ breakMinutes: 30 });

    expect(formatShiftTime('08:00:00')).toBe('08:00');
    expect(formatShiftTime('08:00:05')).toBe('08:00:05');
    expect(formatShiftWorkDays([5, 1, 7])).toBe('Senin, Jumat, Minggu');
  });
});
