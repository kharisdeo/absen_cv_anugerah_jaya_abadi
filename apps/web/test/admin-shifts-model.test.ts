import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listShifts: vi.fn(),
  createShift: vi.fn(),
  updateShift: vi.fn(),
  deactivateShift: vi.fn(),
}));

vi.mock('../src/api/admin-shifts-api.js', () => ({ adminShiftsApi: api }));

import type { WorkShiftDto } from '../src/api/admin-shifts-api.js';
import { AdminShiftsModel } from '../src/pages/admin-shifts-model.js';

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

const input = {
  name: 'Shift Siang',
  startTime: '13:00:00',
  endTime: '21:00:00',
  breakMinutes: 45,
  lateToleranceMinutes: 0,
  workDays: [1, 2, 3, 4, 5],
};

describe('admin shifts state model', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads server data and keeps loading/error state explicit', async () => {
    const model = new AdminShiftsModel();
    api.listShifts.mockResolvedValue([shift]);

    await model.loadShifts();

    expect(model.getSnapshot()).toMatchObject({
      shifts: [shift],
      shiftsState: 'ready',
      shiftsError: null,
    });
  });

  it('creates and edits only with server responses as the new list state', async () => {
    const model = new AdminShiftsModel();
    api.listShifts.mockResolvedValue([shift]);
    await model.loadShifts();

    const created = { ...shift, id: '00000000-0000-4000-8000-000000000402', ...input };
    api.createShift.mockResolvedValue(created);
    await expect(model.saveShift(null, input)).resolves.toBe(true);
    expect(api.createShift).toHaveBeenCalledWith(input);
    expect(model.getSnapshot().shifts).toEqual([shift, created]);

    const updated = { ...created, name: 'Shift Sore' };
    api.updateShift.mockResolvedValue(updated);
    await expect(model.saveShift(created.id, { name: 'Shift Sore' })).resolves.toBe(true);
    expect(api.updateShift).toHaveBeenCalledWith(created.id, { name: 'Shift Sore' });
    expect(model.getSnapshot().shifts).toEqual([shift, updated]);
  });

  it('requires confirmation before calling deactivate and keeps failure retryable', async () => {
    const model = new AdminShiftsModel();
    api.listShifts.mockResolvedValue([shift]);
    await model.loadShifts();

    model.requestDeactivation(shift.id);
    expect(api.deactivateShift).not.toHaveBeenCalled();
    expect(model.getSnapshot().pendingDeactivation).toEqual({
      shiftId: shift.id,
      name: shift.name,
    });

    const failure = new Error('hidden server failure');
    api.deactivateShift.mockRejectedValueOnce(failure);
    await expect(model.confirmDeactivation()).resolves.toBe(false);
    expect(model.getSnapshot()).toMatchObject({
      pendingDeactivation: { shiftId: shift.id, name: shift.name },
      confirmationError: failure,
      confirmationBusy: false,
    });

    api.deactivateShift.mockResolvedValueOnce({ ...shift, isActive: false });
    await expect(model.confirmDeactivation()).resolves.toBe(true);
    expect(api.deactivateShift).toHaveBeenCalledTimes(2);
    expect(model.getSnapshot().shifts[0]?.isActive).toBe(false);
    expect(model.getSnapshot().pendingDeactivation).toBeNull();
  });

  it('cancels without a request and refuses to request deactivation for inactive shifts', async () => {
    const model = new AdminShiftsModel();
    api.listShifts.mockResolvedValue([{ ...shift, isActive: false }]);
    await model.loadShifts();

    model.requestDeactivation(shift.id);
    expect(model.getSnapshot().pendingDeactivation).toBeNull();

    api.listShifts.mockResolvedValue([shift]);
    await model.loadShifts();
    model.requestDeactivation(shift.id);
    model.cancelDeactivation();

    expect(model.getSnapshot().pendingDeactivation).toBeNull();
    expect(api.deactivateShift).not.toHaveBeenCalled();
  });
});
