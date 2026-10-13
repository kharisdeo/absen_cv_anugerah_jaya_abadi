import { describe, expect, it } from 'vitest';

import { EmployeeStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditActor, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  EmployeeService,
  type EmployeeCreateData,
  type EmployeeRecord,
  type EmployeeRepository,
} from '../../src/modules/employee/index.js';

const adminId = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const employeeId = 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9';
const now = new Date('2026-10-11T03:15:00.000Z');
const admin: AuditActor = { role: UserRole.ADMIN, userAccountId: adminId };
const employeeActor: AuditActor = {
  role: UserRole.EMPLOYEE,
  employeeId,
  userAccountId: employeeId,
};

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: employeeId,
    nik: 'NIK-001',
    fullName: 'Karyawan Satu',
    position: 'Staff',
    status: EmployeeStatus.ACTIVE,
    employmentDate: new Date('2024-01-02T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHarness(
  initial: readonly EmployeeRecord[] = [],
  accountUsernames: readonly string[] = [],
) {
  const rows = [...initial];
  const usernames = new Set(accountUsernames);
  const events: RecordAuditEventInput[] = [];
  const repository: EmployeeRepository = {
    async list() {
      return rows;
    },
    async findById(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async findByNik(nik) {
      return rows.find((row) => row.nik === nik) ?? null;
    },
    async findAccountByUsername(username) {
      return usernames.has(username) ? { id: adminId } : null;
    },
    async create(data: EmployeeCreateData) {
      const created = makeEmployee({
        ...data,
        id: '8f9a9fcb-5463-48dc-bc97-2cd2c6f61a2d',
        createdAt: now,
        updatedAt: now,
      });
      rows.push(created);
      return created;
    },
    async update(id, data) {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];
      if (!current) return null;
      const updated = { ...current, ...data, updatedAt: new Date(now.getTime() + 1) };
      rows[index] = updated;
      return updated;
    },
  };
  const audit = {
    async record(event: RecordAuditEventInput) {
      events.push(event);
      return {} as Awaited<
        ReturnType<import('../../src/modules/audit/index.js').AuditService['record']>
      >;
    },
  };
  return { service: new EmployeeService(repository, audit), rows, events };
}

describe('EmployeeService', () => {
  it('allows only Admin actors to read employee data', async () => {
    const { service } = makeHarness([makeEmployee()]);
    await expect(service.list(employeeActor)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    await expect(service.get(employeeActor, employeeId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('trims employee fields, defaults status to active, and audits a safe DTO', async () => {
    const { service, events } = makeHarness();
    const created = await service.create(admin, {
      nik: '  NIK-002  ',
      fullName: '  Karyawan Dua  ',
      position: '  Kasir  ',
      employmentDate: '2025-06-07',
    });

    expect(created).toMatchObject({
      nik: 'NIK-002',
      fullName: 'Karyawan Dua',
      position: 'Kasir',
      status: EmployeeStatus.ACTIVE,
      employmentDate: new Date('2025-06-07T00:00:00.000Z'),
    });
    expect(created).not.toHaveProperty('passwordHash');
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'employee.create',
      entityType: 'employee',
      entityId: created.id,
      after: { nik: 'NIK-002', fullName: 'Karyawan Dua', position: 'Kasir' },
    });
    expect(events[0]?.after).not.toHaveProperty('passwordHash');
  });

  it('rejects an exact duplicate trimmed NIK and invalid calendar dates', async () => {
    const { service } = makeHarness([makeEmployee()]);
    await expect(
      service.create(admin, { nik: ' NIK-001 ', fullName: 'Duplicate' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMPLOYEE_NIK_CONFLICT',
    });
    await expect(
      service.create(admin, {
        nik: 'NIK-002',
        fullName: 'Valid Name',
        employmentDate: '2025-02-30',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_EMPLOYEE_INPUT' });
  });

  it('refuses to change an employee NIK to an existing account username', async () => {
    const { service, rows, events } = makeHarness([makeEmployee()], ['NIK-002']);
    await expect(service.update(admin, employeeId, { nik: ' NIK-002 ' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMPLOYEE_NIK_USERNAME_CONFLICT',
    });
    expect(rows[0]?.nik).toBe('NIK-001');
    expect(events).toHaveLength(0);
  });

  it('lists and reads only the employee DTO fields', async () => {
    const { service } = makeHarness([makeEmployee()]);
    const [listed] = await service.list(admin);
    const found = await service.get(admin, employeeId);
    expect(listed).toEqual(found);
    expect(Object.keys(found).sort()).toEqual(
      [
        'createdAt',
        'employmentDate',
        'fullName',
        'id',
        'nik',
        'position',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('updates only provided fields and audits before/after snapshots', async () => {
    const { service, events } = makeHarness([makeEmployee()]);
    const updated = await service.update(admin, employeeId, { fullName: '  Nama Baru  ' });
    expect(updated.fullName).toBe('Nama Baru');
    expect(updated.nik).toBe('NIK-001');
    expect(events[0]).toMatchObject({
      action: 'employee.update',
      before: { fullName: 'Karyawan Satu' },
      after: { fullName: 'Nama Baru' },
    });
  });

  it('soft-deactivates an employee and makes repeated deactivation idempotent', async () => {
    const { service, rows, events } = makeHarness([makeEmployee()]);
    const deactivated = await service.deactivate(admin, employeeId);
    expect(deactivated.status).toBe(EmployeeStatus.INACTIVE);
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'employee.deactivate',
      entityType: 'employee',
      entityId: employeeId,
      before: { status: EmployeeStatus.ACTIVE },
      after: { status: EmployeeStatus.INACTIVE },
    });
    await service.deactivate(admin, employeeId);
    expect(events).toHaveLength(1);
  });

  it('rejects empty updates and invalid employee IDs', async () => {
    const { service } = makeHarness([makeEmployee()]);
    await expect(service.update(admin, employeeId, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.get(admin, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
  });
});
