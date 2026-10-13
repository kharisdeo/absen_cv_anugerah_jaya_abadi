import {
  adminEmployeesApi,
  type EmployeeDto,
  type EmployeeProfileInput,
  type EmployeeProfilePatch,
} from '../api/admin-employees-api.js';

export type EmployeeRequestState = 'idle' | 'loading' | 'ready' | 'error';
export type EmployeeEditorState = 'closed' | 'loading' | 'ready' | 'error';
export type EmployeeMutationState = 'idle' | 'saving';

export type AdminEmployeesSnapshot = Readonly<{
  employees: readonly EmployeeDto[];
  employeesState: EmployeeRequestState;
  employeesError: unknown | null;
  editorState: EmployeeEditorState;
  editorEmployee: EmployeeDto | null;
  editorError: unknown | null;
  mutation: EmployeeMutationState;
  mutationError: unknown | null;
  pendingDeactivation: EmployeeDto | null;
  confirmationBusy: boolean;
  confirmationError: unknown | null;
  notice: string | null;
}>;

const initialSnapshot: AdminEmployeesSnapshot = {
  employees: [],
  employeesState: 'idle',
  employeesError: null,
  editorState: 'closed',
  editorEmployee: null,
  editorError: null,
  mutation: 'idle',
  mutationError: null,
  pendingDeactivation: null,
  confirmationBusy: false,
  confirmationError: null,
  notice: null,
};

export class AdminEmployeesModel {
  private snapshot: AdminEmployeesSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private employeesRequestId = 0;
  private employeeRequestId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AdminEmployeesSnapshot => this.snapshot;

  readonly getServerSnapshot = (): AdminEmployeesSnapshot => this.snapshot;

  private update(patch: Partial<AdminEmployeesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async loadEmployees(signal?: AbortSignal): Promise<void> {
    const requestId = ++this.employeesRequestId;
    this.update({ employeesState: 'loading', employeesError: null });
    try {
      const employees = await adminEmployeesApi.listEmployees(signal);
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employees, employeesState: 'ready', employeesError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.employeesRequestId) return;
      this.update({ employeesState: 'error', employeesError: error });
    }
  }

  beginCreate(): void {
    if (this.snapshot.mutation !== 'idle') return;
    this.employeeRequestId += 1;
    this.update({
      editorState: 'ready',
      editorEmployee: null,
      editorError: null,
      mutationError: null,
      notice: null,
    });
  }

  async beginEdit(employeeId: string, signal?: AbortSignal): Promise<void> {
    if (this.snapshot.mutation !== 'idle') return;
    const requestId = ++this.employeeRequestId;
    this.update({
      editorState: 'loading',
      editorEmployee: null,
      editorError: null,
      mutationError: null,
      notice: null,
    });
    try {
      const employee = await adminEmployeesApi.getEmployee(employeeId, signal);
      if (signal?.aborted || requestId !== this.employeeRequestId) return;
      this.update({ editorState: 'ready', editorEmployee: employee, editorError: null });
    } catch (error: unknown) {
      if (signal?.aborted || requestId !== this.employeeRequestId) return;
      this.update({ editorState: 'error', editorError: error });
    }
  }

  closeEditor(): void {
    if (this.snapshot.mutation === 'saving') return;
    this.employeeRequestId += 1;
    this.update({
      editorState: 'closed',
      editorEmployee: null,
      editorError: null,
      mutationError: null,
    });
  }

  async createEmployee(input: EmployeeProfileInput): Promise<boolean> {
    if (this.snapshot.mutation !== 'idle') return false;
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      const created = await adminEmployeesApi.createEmployee(input);
      const employees = this.snapshot.employees.filter((employee) => employee.id !== created.id);
      this.update({
        employees: [...employees, created],
        employeesState: 'ready',
        employeesError: null,
        mutation: 'idle',
        editorState: 'closed',
        editorEmployee: null,
        notice: 'Profil karyawan berhasil ditambahkan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  async updateEmployee(employeeId: string, input: EmployeeProfilePatch): Promise<boolean> {
    if (this.snapshot.mutation !== 'idle' || Object.keys(input).length === 0) return false;
    this.update({ mutation: 'saving', mutationError: null, notice: null });
    try {
      const updated = await adminEmployeesApi.updateEmployee(employeeId, input);
      this.update({
        employees: this.snapshot.employees.map((employee) =>
          employee.id === updated.id ? updated : employee,
        ),
        employeesState: 'ready',
        employeesError: null,
        mutation: 'idle',
        editorState: 'closed',
        editorEmployee: null,
        notice: 'Perubahan profil karyawan berhasil disimpan.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ mutation: 'idle', mutationError: error });
      return false;
    }
  }

  requestDeactivation(employeeId: string): void {
    if (this.snapshot.confirmationBusy || this.snapshot.mutation !== 'idle') return;
    const employee = this.snapshot.employees.find((item) => item.id === employeeId);
    if (!employee || employee.status !== 'ACTIVE') return;
    this.update({
      pendingDeactivation: employee,
      confirmationError: null,
      notice: null,
    });
  }

  cancelDeactivation(): void {
    if (this.snapshot.confirmationBusy) return;
    this.update({ pendingDeactivation: null, confirmationError: null });
  }

  async confirmDeactivation(): Promise<boolean> {
    const employee = this.snapshot.pendingDeactivation;
    if (!employee || this.snapshot.confirmationBusy || employee.status !== 'ACTIVE') return false;
    this.update({ confirmationBusy: true, confirmationError: null });
    try {
      const updated = await adminEmployeesApi.deactivateEmployee(employee.id);
      this.update({
        employees: this.snapshot.employees.map((item) => (item.id === updated.id ? updated : item)),
        employeesState: 'ready',
        employeesError: null,
        pendingDeactivation: null,
        notice: 'Profil karyawan ditandai tidak aktif oleh server.',
      });
      return true;
    } catch (error: unknown) {
      this.update({ confirmationError: error });
      return false;
    } finally {
      this.update({ confirmationBusy: false });
    }
  }
}
