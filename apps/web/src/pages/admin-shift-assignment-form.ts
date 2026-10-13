import type { EmployeeDto } from '../api/admin-employees-api.js';
import type {
  ShiftAssignmentCreateInput,
  ShiftAssignmentDto,
  ShiftAssignmentUpdateInput,
} from '../api/admin-shift-assignments-api.js';
import type { StoreDto } from '../api/admin-stores-api.js';
import type { WorkShiftDto } from '../api/admin-shifts-api.js';

export type ShiftAssignmentDraft = Readonly<{
  employeeId: string;
  workShiftId: string;
  scope: string;
  effectiveFrom: string;
  effectiveTo: string;
}>;

export type ShiftAssignmentDraftField = keyof ShiftAssignmentDraft;

export type ShiftAssignmentFormOptions = Readonly<{
  employees: readonly EmployeeDto[];
  stores: readonly StoreDto[];
  shifts: readonly WorkShiftDto[];
  employeeStoreIds: Readonly<Record<string, readonly string[]>>;
  assignment?: ShiftAssignmentDto;
}>;

export type ShiftAssignmentValidation = Readonly<{
  input?: ShiftAssignmentCreateInput;
  errors: Partial<Record<ShiftAssignmentDraftField, string>>;
}>;

export function emptyShiftAssignmentDraft(): ShiftAssignmentDraft {
  return {
    employeeId: '',
    workShiftId: '',
    scope: '',
    effectiveFrom: '',
    effectiveTo: '',
  };
}

export function shiftAssignmentToDraft(assignment: ShiftAssignmentDto): ShiftAssignmentDraft {
  return {
    employeeId: assignment.employeeId,
    workShiftId: assignment.workShiftId,
    scope: assignment.storeId ?? 'global',
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo ?? '',
  };
}

export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validEmployee(employeeId: string, options: ShiftAssignmentFormOptions): boolean {
  if (options.assignment) return employeeId === options.assignment.employeeId;
  return options.employees.some(
    (employee) => employee.id === employeeId && employee.status === 'ACTIVE',
  );
}

function validShift(shiftId: string, options: ShiftAssignmentFormOptions): boolean {
  return options.shifts.some(
    (shift) =>
      shift.id === shiftId && (shift.isActive || shift.id === options.assignment?.workShiftId),
  );
}

export function eligibleStoresForEmployee(
  employeeId: string,
  options: ShiftAssignmentFormOptions,
): readonly StoreDto[] {
  const assignedIds = new Set(options.employeeStoreIds[employeeId] ?? []);
  const eligible = options.stores.filter((store) => store.isActive && assignedIds.has(store.id));
  const currentStoreId = options.assignment?.storeId;
  if (currentStoreId && !eligible.some((store) => store.id === currentStoreId)) {
    const existingStore = options.stores.find((store) => store.id === currentStoreId);
    if (existingStore) return [...eligible, existingStore];
  }
  return eligible;
}

export function validateShiftAssignmentDraft(
  draft: ShiftAssignmentDraft,
  options: ShiftAssignmentFormOptions,
): ShiftAssignmentValidation {
  const errors: Partial<Record<ShiftAssignmentDraftField, string>> = {};

  if (!validEmployee(draft.employeeId, options)) {
    errors.employeeId = options.assignment
      ? 'Karyawan penugasan tidak sesuai.'
      : 'Pilih karyawan aktif.';
  }
  if (!validShift(draft.workShiftId, options)) {
    errors.workShiftId = options.assignment
      ? 'Pilih shift aktif atau pertahankan shift penugasan saat ini.'
      : 'Pilih shift aktif.';
  }

  let storeId: string | null | undefined;
  if (draft.scope === 'global') {
    storeId = null;
  } else if (draft.scope) {
    const allowedStores = eligibleStoresForEmployee(draft.employeeId, options);
    if (allowedStores.some((store) => store.id === draft.scope)) {
      storeId = draft.scope;
    } else {
      errors.scope = 'Pilih toko aktif yang sudah menjadi penugasan karyawan.';
    }
  } else {
    errors.scope = 'Pilih cakupan global atau toko.';
  }

  if (!draft.effectiveFrom) {
    errors.effectiveFrom = 'Tanggal mulai berlaku wajib diisi.';
  } else if (!isValidCalendarDate(draft.effectiveFrom)) {
    errors.effectiveFrom = 'Masukkan tanggal mulai yang valid.';
  }

  if (draft.effectiveTo && !isValidCalendarDate(draft.effectiveTo)) {
    errors.effectiveTo =
      'Masukkan tanggal akhir yang valid atau kosongkan untuk tanpa batas akhir.';
  } else if (
    draft.effectiveTo &&
    isValidCalendarDate(draft.effectiveFrom) &&
    draft.effectiveTo < draft.effectiveFrom
  ) {
    errors.effectiveTo = 'Tanggal akhir tidak boleh lebih awal dari tanggal mulai.';
  }

  if (Object.keys(errors).length > 0 || storeId === undefined) return { errors };

  return {
    input: {
      employeeId: draft.employeeId,
      workShiftId: draft.workShiftId,
      storeId,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo || null,
    },
    errors,
  };
}

export function shiftAssignmentInputDiff(
  assignment: ShiftAssignmentDto,
  input: ShiftAssignmentCreateInput,
): ShiftAssignmentUpdateInput {
  const patch: {
    workShiftId?: string;
    storeId?: string | null;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  } = {};
  if (input.workShiftId !== assignment.workShiftId) patch.workShiftId = input.workShiftId;
  if (input.storeId !== assignment.storeId) patch.storeId = input.storeId;
  if (input.effectiveFrom !== assignment.effectiveFrom) patch.effectiveFrom = input.effectiveFrom;
  if (input.effectiveTo !== assignment.effectiveTo) patch.effectiveTo = input.effectiveTo;
  return patch;
}

export function validateAssignmentDeactivationDate(
  value: string,
  assignment: ShiftAssignmentDto,
): string | null {
  if (!value) return 'Tanggal akhir berlaku wajib diisi.';
  if (!isValidCalendarDate(value)) return 'Masukkan tanggal akhir yang valid.';
  if (value < assignment.effectiveFrom) {
    return 'Tanggal akhir tidak boleh lebih awal dari tanggal mulai penugasan.';
  }
  if (assignment.effectiveTo !== null && value > assignment.effectiveTo) {
    return 'Tanggal akhir tidak boleh memperpanjang tanggal akhir yang sudah ditetapkan.';
  }
  return null;
}
