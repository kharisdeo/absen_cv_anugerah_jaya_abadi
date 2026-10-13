import { describe, expect, it } from 'vitest';

import {
  employeeProfileDiff,
  employeeToDraft,
  emptyEmployeeDraft,
  formatEmploymentDate,
  validateEmployeeDraft,
} from '../src/pages/admin-employee-form.js';
import type { EmployeeDto } from '../src/api/admin-employees-api.js';

const employee: EmployeeDto = {
  id: '00000000-0000-4000-8000-000000000301',
  nik: 'AJ-001',
  fullName: 'Nama Karyawan',
  position: 'Kasir',
  status: 'ACTIVE',
  employmentDate: '2025-02-28',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('admin employee profile form', () => {
  it('requires NIK and full name and normalizes optional profile fields', () => {
    expect(validateEmployeeDraft(emptyEmployeeDraft()).input).toBeNull();

    const result = validateEmployeeDraft({
      nik: ' AJ-002 ',
      fullName: '  Nama Baru  ',
      position: '  ',
      employmentDate: '',
    });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      nik: 'AJ-002',
      fullName: 'Nama Baru',
      position: null,
      employmentDate: null,
    });
  });

  it('rejects overlong/control-containing text and impossible calendar dates', () => {
    const result = validateEmployeeDraft({
      nik: 'AJ\u0001',
      fullName: 'x'.repeat(151),
      position: 'x'.repeat(101),
      employmentDate: '2025-02-29',
    });

    expect(result.input).toBeNull();
    expect(result.errors.nik).toBeDefined();
    expect(result.errors.fullName).toBeDefined();
    expect(result.errors.position).toBeDefined();
    expect(result.errors.employmentDate).toBeDefined();
  });

  it('builds a minimal patch and formats date-only values without timezone shifts', () => {
    const draft = employeeToDraft(employee);
    const unchanged = validateEmployeeDraft(draft);
    expect(unchanged.input).not.toBeNull();
    expect(employeeProfileDiff(employee, unchanged.input!)).toEqual({});

    const changed = validateEmployeeDraft({ ...draft, position: 'Supervisor' });
    expect(changed.input).not.toBeNull();
    expect(employeeProfileDiff(employee, changed.input!)).toEqual({ position: 'Supervisor' });
    expect(formatEmploymentDate(employee.employmentDate)).toBe('28/02/2025');
  });
});
