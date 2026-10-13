import { adminEmployeesApi, type EmployeeDto } from '../api/admin-employees-api.js';
import {
  adminShiftAssignmentsApi,
  type ShiftAssignmentCreateInput,
  type ShiftAssignmentDto,
  type ShiftAssignmentUpdateInput,
} from '../api/admin-shift-assignments-api.js';
import { adminStoresApi, type StoreDto } from '../api/admin-stores-api.js';

export type AssignmentLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type AssignmentMutationState = 'idle' | 'saving' | 'deactivating';

export type AdminShiftAssignmentsSnapshot = Readonly<{
  assignments: readonly ShiftAssignmentDto[];
  assignmentsState: AssignmentLoadState;
  assignmentsError: unknown | null;
  referencesState: AssignmentLoadState;
  referencesError: unknown | null;
  employees: readonly EmployeeDto[];
  stores: readonly StoreDto[];
  employeeStoreIds: Readonly<Record<string, readonly string[]>>;
  mutation: AssignmentMutationState;
  mutationError: unknown | null;
  pendingDeactivation: ShiftAssignmentDto | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

const initialSnapshot: AdminShiftAssignmentsSnapshot = {
  assignments: [],
  assignmentsState: 'idle',
  assignmentsError: null,
  referencesState: 'idle',
  referencesError: null,
  employees: [],
  stores: [],
  employeeStoreIds: {},
  mutation: 'idle',
  mutationError: null,
  pendingDeactivation: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

function sortAssignments(
  assignments: readonly ShiftAssignmentDto[],
): readonly ShiftAssignmentDto[] {
  return [...assignments].sort((first, second) => {
    const byEffectiveDate = second.effectiveFrom.localeCompare(first.effectiveFrom);
    if (byEffectiveDate !== 0) return byEffectiveDate;
    const byEmployee = first.employee.fullName.localeCompare(second.employee.fullName, 'id');
    return byEmployee !== 0 ? byEmployee : first.id.localeCompare(second.id);
  });
}

export class AdminShiftAssignmentsModel {
  private snapshot: AdminShiftAssignmentsSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private assignmentsRequestId = 0;
  private referencesRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminShiftAssignmentsSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminShiftAssignmentsSnapshot => this.snapshot;

  private update(patch: Partial<AdminShiftAssignmentsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async loadAssignments(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.assignmentsRequestId;
    this.update({ assignmentsState: 'loading', assignmentsError: null });
    try {
      const assignments = await adminShiftAssignmentsApi.listAssignments({}, signal);
      if (signal?.aborted || requestId !== this.assignmentsRequestId) return;
      this.update({
        assignments: sortAssignments(assignments),
        assignmentsState: 'ready',
        assignmentsError: null,
      });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.assignmentsRequestId) return;
      this.update({ assignmentsState: 'error', assignmentsError: error });
    }
  }

  async loadReferences(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.referencesRequestId;
    this.update({ referencesState: 'loading', referencesError: null });
    try {
      const [employees, stores] = await Promise.all([
        adminEmployeesApi.listEmployees(signal),
        adminStoresApi.listStores(signal),
      ]);
      const activeStores = stores.filter((store) => store.isActive);
      const memberships = await Promise.all(
        activeStores.map(async (store) => ({
          storeId: store.id,
          assignments: await adminStoresApi.listAssignments(store.id, signal),
        })),
      );
      if (signal?.aborted || requestId !== this.referencesRequestId) return;

      const employeeStoreIds: Record<string, string[]> = {};
      for (const { storeId, assignments } of memberships) {
        for (const assignment of assignments) {
          const storeIds = employeeStoreIds[assignment.employeeId] ?? [];
          storeIds.push(storeId);
          employeeStoreIds[assignment.employeeId] = storeIds;
        }
      }
      this.update({
        employees,
        stores,
        employeeStoreIds,
        referencesState: 'ready',
        referencesError: null,
      });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.referencesRequestId) return;
      this.update({ referencesState: 'error', referencesError: error });
    }
  }

  clearMutationError(): void {
    this.update({ mutationError: null, notice: null });
  }

  async saveAssignment(
    assignmentId: string | null,
    input: ShiftAssignmentCreateInput | ShiftAssignmentUpdateInput,
  ): Promise<boolean> {
    if (
      this.snapshot.mutation !== 'idle' ||
      this.snapshot.assignmentsState !== 'ready' ||
      this.snapshot.referencesState !== 'ready'
    ) {
      return false;
    }
    this.assignmentsRequestId += 1;
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      const saved = assignmentId
        ? await adminShiftAssignmentsApi.updateAssignment(
            assignmentId,
            input as ShiftAssignmentUpdateInput,
          )
        : await adminShiftAssignmentsApi.createAssignment(input as ShiftAssignmentCreateInput);
      const assignments = assignmentId
        ? this.snapshot.assignments.map((item) => (item.id === saved.id ? saved : item))
        : [...this.snapshot.assignments, saved];
      this.update({
        assignments: sortAssignments(assignments),
        assignmentsState: 'ready',
        assignmentsError: null,
        mutation: 'idle',
        mutationError: null,
        notice: assignmentId
          ? 'Perubahan penugasan shift berhasil disimpan.'
          : 'Penugasan shift berhasil ditambahkan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  requestDeactivation(assignmentId: string): void {
    const assignment = this.snapshot.assignments.find((item) => item.id === assignmentId);
    if (!assignment || this.snapshot.mutation !== 'idle') return;
    this.update({
      pendingDeactivation: assignment,
      confirmationError: null,
      notice: null,
    });
  }

  cancelDeactivation(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingDeactivation: null, confirmationError: null });
  }

  async confirmDeactivation(effectiveTo: string): Promise<boolean> {
    const assignment = this.snapshot.pendingDeactivation;
    if (!assignment || this.snapshot.confirmationBusy || this.snapshot.mutation !== 'idle') {
      return false;
    }
    this.assignmentsRequestId += 1;
    this.update({ confirmationBusy: true, confirmationError: null, mutation: 'deactivating' });
    try {
      const updated = await adminShiftAssignmentsApi.deactivateAssignment(
        assignment.id,
        effectiveTo,
      );
      this.update({
        assignments: sortAssignments(
          this.snapshot.assignments.map((item) => (item.id === updated.id ? updated : item)),
        ),
        assignmentsState: 'ready',
        assignmentsError: null,
        mutation: 'idle',
        pendingDeactivation: null,
        notice: 'Tanggal akhir penugasan shift berhasil disimpan.',
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
