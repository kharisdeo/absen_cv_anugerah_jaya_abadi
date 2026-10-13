import type {
  EmployeeDto,
  EmployeeProfileInput,
  EmployeeProfilePatch,
} from '../api/admin-employees-api.js';

export type EmployeeDraft = Readonly<{
  nik: string;
  fullName: string;
  position: string;
  employmentDate: string;
}>;

export type EmployeeDraftField = keyof EmployeeDraft;
export type EmployeeDraftErrors = Partial<Record<EmployeeDraftField, string>>;

export function emptyEmployeeDraft(): EmployeeDraft {
  return { nik: '', fullName: '', position: '', employmentDate: '' };
}

function dateOnly(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? '';
}

export function employeeToDraft(employee: EmployeeDto): EmployeeDraft {
  return {
    nik: employee.nik,
    fullName: employee.fullName,
    position: employee.position ?? '',
    employmentDate: dateOnly(employee.employmentDate),
  };
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function validateEmployeeDraft(draft: EmployeeDraft): Readonly<{
  errors: EmployeeDraftErrors;
  input: EmployeeProfileInput | null;
}> {
  const errors: EmployeeDraftErrors = {};
  const nik = draft.nik.trim();
  const fullName = draft.fullName.trim();
  const position = draft.position.trim();
  const employmentDate = draft.employmentDate.trim();

  if (!nik) errors.nik = 'NIK wajib diisi.';
  else if (nik.length > 64) errors.nik = 'NIK maksimal 64 karakter.';
  else if (hasControlCharacters(nik)) errors.nik = 'NIK tidak boleh berisi karakter kontrol.';

  if (!fullName) errors.fullName = 'Nama lengkap wajib diisi.';
  else if (fullName.length > 150) errors.fullName = 'Nama lengkap maksimal 150 karakter.';
  else if (hasControlCharacters(fullName)) {
    errors.fullName = 'Nama lengkap tidak boleh berisi karakter kontrol.';
  }

  if (position.length > 100) errors.position = 'Jabatan maksimal 100 karakter.';
  else if (hasControlCharacters(position)) {
    errors.position = 'Jabatan tidak boleh berisi karakter kontrol.';
  }

  if (employmentDate && !isRealDate(employmentDate)) {
    errors.employmentDate = 'Tanggal mulai harus berupa tanggal kalender yang valid.';
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: {
      nik,
      fullName,
      position: position || null,
      employmentDate: employmentDate || null,
    },
  };
}

export function employeeProfileDiff(
  employee: EmployeeDto,
  input: EmployeeProfileInput,
): EmployeeProfilePatch {
  const current = employeeToDraft(employee);
  const next = {
    nik: input.nik,
    fullName: input.fullName,
    position: input.position ?? '',
    employmentDate: input.employmentDate ?? '',
  };
  const patch: { -readonly [Key in keyof EmployeeProfileInput]?: EmployeeProfileInput[Key] } = {};

  if (next.nik !== current.nik) patch.nik = next.nik;
  if (next.fullName !== current.fullName) patch.fullName = next.fullName;
  if (next.position !== current.position) patch.position = input.position;
  if (next.employmentDate !== current.employmentDate) {
    patch.employmentDate = input.employmentDate;
  }
  return patch;
}

export function formatEmploymentDate(value: string | null): string {
  const date = dateOnly(value);
  if (!date || !isRealDate(date)) return 'Belum diisi';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}
