import {
  adminShiftsApi,
  type ShiftWriteInput,
  type ShiftUpdateInput,
  type WorkShiftDto,
} from '../api/admin-shifts-api.js';

export type ShiftListState = 'idle' | 'loading' | 'ready' | 'error';
export type ShiftMutationState = 'idle' | 'saving' | 'deactivating';

export type AdminShiftsSnapshot = Readonly<{
  shifts: readonly WorkShiftDto[];
  shiftsState: ShiftListState;
  shiftsError: unknown | null;
  mutation: ShiftMutationState;
  mutationError: unknown | null;
  pendingDeactivation: Readonly<{ shiftId: string; name: string }> | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

const initialSnapshot: AdminShiftsSnapshot = {
  shifts: [],
  shiftsState: 'idle',
  shiftsError: null,
  mutation: 'idle',
  mutationError: null,
  pendingDeactivation: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

export class AdminShiftsModel {
  private snapshot: AdminShiftsSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private shiftsRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminShiftsSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminShiftsSnapshot => this.snapshot;

  private update(patch: Partial<AdminShiftsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async loadShifts(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.shiftsRequestId;
    this.update({ shiftsState: 'loading', shiftsError: null });
    try {
      const shifts = await adminShiftsApi.listShifts(signal);
      if (signal?.aborted || requestId !== this.shiftsRequestId) return;
      this.update({ shifts, shiftsState: 'ready', shiftsError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.shiftsRequestId) return;
      this.update({ shiftsState: 'error', shiftsError: error });
    }
  }

  clearMutationError(): void {
    this.update({ mutationError: null, notice: null });
  }

  async saveShift(
    shiftId: string | null,
    input: ShiftWriteInput | ShiftUpdateInput,
  ): Promise<boolean> {
    if (this.snapshot.mutation !== 'idle' || this.snapshot.shiftsState !== 'ready') return false;
    this.shiftsRequestId += 1;
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      const saved = shiftId
        ? await adminShiftsApi.updateShift(shiftId, input)
        : await adminShiftsApi.createShift(input as ShiftWriteInput);
      const shifts = shiftId
        ? this.snapshot.shifts.map((shift) => (shift.id === saved.id ? saved : shift))
        : [...this.snapshot.shifts, saved];
      this.update({
        shifts,
        shiftsState: 'ready',
        shiftsError: null,
        mutation: 'idle',
        mutationError: null,
        notice: shiftId ? 'Perubahan shift berhasil disimpan.' : 'Shift berhasil ditambahkan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  requestDeactivation(shiftId: string): void {
    const shift = this.snapshot.shifts.find((item) => item.id === shiftId);
    if (!shift?.isActive || this.snapshot.mutation !== 'idle') return;
    this.update({
      pendingDeactivation: { shiftId, name: shift.name },
      confirmationError: null,
      notice: null,
    });
  }

  cancelDeactivation(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingDeactivation: null, confirmationError: null });
  }

  async confirmDeactivation(): Promise<boolean> {
    const request = this.snapshot.pendingDeactivation;
    if (!request || this.snapshot.confirmationBusy || this.snapshot.mutation !== 'idle')
      return false;
    this.shiftsRequestId += 1;
    this.update({ confirmationBusy: true, confirmationError: null, mutation: 'deactivating' });
    try {
      const updated = await adminShiftsApi.deactivateShift(request.shiftId);
      this.update({
        shifts: this.snapshot.shifts.map((shift) => (shift.id === updated.id ? updated : shift)),
        mutation: 'idle',
        pendingDeactivation: null,
        notice: 'Shift ditandai tidak aktif oleh server.',
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
