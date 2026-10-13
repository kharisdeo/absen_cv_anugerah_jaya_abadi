import {
  adminStoresApi,
  type EmployeeOptionDto,
  type StoreAssignmentDto,
  type StoreDto,
  type StoreWriteInput,
} from '../api/admin-stores-api.js';

export type RequestState = 'idle' | 'loading' | 'ready' | 'error';
export type StoreMutationState = 'idle' | 'saving' | 'deactivating';
export type AssignmentMutationState = 'idle' | 'assigning' | 'removing';

export type ConfirmationRequest =
  | Readonly<{ action: 'deactivate'; storeId: string }>
  | Readonly<{
      action: 'update-store';
      storeId: string;
      storeName: string;
      input: StoreWriteInput;
      changedFields: readonly string[];
    }>
  | Readonly<{
      action: 'remove-assignment';
      storeId: string;
      employeeId: string;
      employeeName: string;
    }>;

export type AdminStoresSnapshot = Readonly<{
  stores: readonly StoreDto[];
  storesState: RequestState;
  storesError: unknown | null;
  selectedStoreId: string | null;
  assignments: readonly StoreAssignmentDto[];
  assignmentsState: RequestState;
  assignmentsError: unknown | null;
  employees: readonly EmployeeOptionDto[];
  employeesState: RequestState;
  employeesError: unknown | null;
  storeMutation: StoreMutationState;
  storeMutationError: unknown | null;
  assignmentMutation: AssignmentMutationState;
  assignmentMutationError: unknown | null;
  pendingConfirmation: ConfirmationRequest | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

const initialSnapshot: AdminStoresSnapshot = {
  stores: [],
  storesState: 'idle',
  storesError: null,
  selectedStoreId: null,
  assignments: [],
  assignmentsState: 'idle',
  assignmentsError: null,
  employees: [],
  employeesState: 'idle',
  employeesError: null,
  storeMutation: 'idle',
  storeMutationError: null,
  assignmentMutation: 'idle',
  assignmentMutationError: null,
  pendingConfirmation: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

export class AdminStoresModel {
  private snapshot: AdminStoresSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private storesRequestId = 0;
  private employeesRequestId = 0;
  private assignmentsRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminStoresSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminStoresSnapshot => this.snapshot;

  private update(patch: Partial<AdminStoresSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async loadStores(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.storesRequestId;
    this.update({ storesState: 'loading', storesError: null });
    try {
      const stores = await adminStoresApi.listStores(signal);
      if (signal?.aborted || requestId !== this.storesRequestId) return;
      const selectedStoreId = stores.some((store) => store.id === this.snapshot.selectedStoreId)
        ? this.snapshot.selectedStoreId
        : (stores[0]?.id ?? null);
      this.update({ stores, storesState: 'ready', storesError: null, selectedStoreId });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.storesRequestId) return;
      this.update({ storesState: 'error', storesError: error });
    }
  }

  async loadEmployees(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.employeesRequestId;
    this.update({ employeesState: 'loading', employeesError: null });
    try {
      const employees = await adminStoresApi.listEmployees(signal);
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employees, employeesState: 'ready', employeesError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employeesState: 'error', employeesError: error });
    }
  }

  async loadAssignments(storeId: string, signal?: AbortSignal): Promise<boolean> {
    if (this.snapshot.selectedStoreId !== storeId) return false;
    const requestId = ++this.assignmentsRequestId;
    this.update({
      assignments: [],
      assignmentsState: 'loading',
      assignmentsError: null,
    });
    try {
      const assignments = await adminStoresApi.listAssignments(storeId, signal);
      if (
        signal?.aborted ||
        requestId !== this.assignmentsRequestId ||
        this.snapshot.selectedStoreId !== storeId
      ) {
        return false;
      }
      this.update({ assignments, assignmentsState: 'ready', assignmentsError: null });
      return true;
    } catch (error: unknown) {
      if (
        signal?.aborted ||
        requestId !== this.assignmentsRequestId ||
        this.snapshot.selectedStoreId !== storeId
      ) {
        return false;
      }
      this.update({ assignmentsState: 'error', assignmentsError: error });
      return false;
    }
  }

  selectStore(storeId: string): void {
    if (!this.snapshot.stores.some((store) => store.id === storeId)) return;
    if (this.snapshot.selectedStoreId === storeId) return;
    this.assignmentsRequestId += 1;
    this.update({
      selectedStoreId: storeId,
      assignments: [],
      assignmentsState: 'idle',
      assignmentsError: null,
      assignmentMutationError: null,
      notice: null,
    });
  }

  async saveStore(storeId: string | null, input: StoreWriteInput): Promise<boolean> {
    if (this.snapshot.storeMutation !== 'idle') return false;
    this.update({ storeMutation: 'saving', storeMutationError: null, notice: null });
    try {
      const saved = storeId
        ? await adminStoresApi.updateStore(storeId, input)
        : await adminStoresApi.createStore(input);
      const stores = storeId
        ? this.snapshot.stores.map((store) => (store.id === saved.id ? saved : store))
        : [...this.snapshot.stores, saved];
      this.update({
        stores,
        storesState: 'ready',
        storesError: null,
        selectedStoreId: saved.id,
        storeMutation: 'idle',
        storeMutationError: null,
        notice: storeId ? 'Perubahan toko berhasil disimpan.' : 'Toko berhasil ditambahkan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ storeMutation: 'idle', storeMutationError: error });
      return false;
    }
  }

  requestStoreUpdateConfirmation(
    storeId: string,
    input: StoreWriteInput,
    changedFields: readonly string[],
  ): void {
    const store = this.snapshot.stores.find((item) => item.id === storeId);
    if (
      !store ||
      changedFields.length === 0 ||
      this.snapshot.storeMutation !== 'idle' ||
      this.snapshot.confirmationBusy
    ) {
      return;
    }
    this.update({
      pendingConfirmation: {
        action: 'update-store',
        storeId,
        storeName: store.name,
        input,
        changedFields,
      },
      confirmationError: null,
      notice: null,
    });
  }

  requestDeactivate(storeId: string): void {
    const store = this.snapshot.stores.find((item) => item.id === storeId);
    if (!store?.isActive || this.snapshot.storeMutation !== 'idle') return;
    this.update({
      pendingConfirmation: { action: 'deactivate', storeId },
      confirmationError: null,
      notice: null,
    });
  }

  requestAssignmentRemoval(assignment: StoreAssignmentDto): void {
    if (this.snapshot.assignmentMutation !== 'idle') return;
    this.update({
      pendingConfirmation: {
        action: 'remove-assignment',
        storeId: assignment.storeId,
        employeeId: assignment.employeeId,
        employeeName: assignment.employee.fullName,
      },
      confirmationError: null,
      notice: null,
    });
  }

  cancelConfirmation(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingConfirmation: null, confirmationError: null });
  }

  async confirmPendingAction(): Promise<boolean> {
    const request = this.snapshot.pendingConfirmation;
    if (!request || this.snapshot.confirmationBusy) return false;
    this.update({ confirmationBusy: true, confirmationError: null });
    try {
      if (request.action === 'deactivate') {
        this.update({ storeMutation: 'deactivating' });
        const updated = await adminStoresApi.deactivateStore(request.storeId);
        this.update({
          stores: this.snapshot.stores.map((store) => (store.id === updated.id ? updated : store)),
          storeMutation: 'idle',
          pendingConfirmation: null,
          notice: 'Toko ditandai tidak aktif oleh server.',
        });
      } else if (request.action === 'update-store') {
        this.update({ storeMutation: 'saving' });
        const updated = await adminStoresApi.updateStore(request.storeId, request.input);
        this.update({
          stores: this.snapshot.stores.map((store) => (store.id === updated.id ? updated : store)),
          storeMutation: 'idle',
          pendingConfirmation: null,
          notice: 'Perubahan lokasi dan validasi toko berhasil disimpan.',
        });
      } else {
        this.update({ assignmentMutation: 'removing' });
        await adminStoresApi.removeEmployee(request.storeId, request.employeeId);
        this.update({
          assignmentMutation: 'idle',
          pendingConfirmation: null,
          notice: 'Penugasan karyawan diperbarui oleh server.',
        });
        await this.loadAssignments(request.storeId);
      }
      return true;
    } catch (error: unknown) {
      if (request.action === 'deactivate' || request.action === 'update-store') {
        this.update({ storeMutation: 'idle' });
      } else {
        this.update({ assignmentMutation: 'idle', assignmentMutationError: error });
      }
      this.update({ confirmationError: error });
      return false;
    } finally {
      this.update({ confirmationBusy: false });
    }
  }

  async assignEmployee(storeId: string, employeeId: string): Promise<boolean> {
    if (this.snapshot.assignmentMutation !== 'idle' || this.snapshot.selectedStoreId !== storeId) {
      return false;
    }
    const employee = this.snapshot.employees.find((item) => item.id === employeeId);
    const alreadyAssigned = this.snapshot.assignments.some(
      (assignment) => assignment.employeeId === employeeId,
    );
    if (!employee || employee.status !== 'ACTIVE' || alreadyAssigned) return false;

    this.update({
      assignmentMutation: 'assigning',
      assignmentMutationError: null,
      notice: null,
    });
    try {
      await adminStoresApi.assignEmployee(storeId, employeeId);
      this.update({
        assignmentMutation: 'idle',
        notice: 'Penugasan karyawan dikirim ke server.',
      });
      await this.loadAssignments(storeId);
      return true;
    } catch (error: unknown) {
      this.update({ assignmentMutation: 'idle', assignmentMutationError: error });
      return false;
    }
  }
}
