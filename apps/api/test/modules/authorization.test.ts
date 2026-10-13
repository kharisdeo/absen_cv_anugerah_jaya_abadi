import { describe, expect, it } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  assertCanAccessAttendance,
  assertCanAccessEmployee,
  attendanceScopeWhere,
  buildAttendanceDetailWhere,
  buildAttendanceListWhere,
  buildEmployeeDetailWhere,
  buildEmployeeListWhere,
  canAccessAttendance,
  canAccessEmployee,
  employeeScopeWhere,
  type AuthorizationActor,
} from '../../src/modules/authorization/index.js';

const admin: AuthorizationActor = { role: UserRole.ADMIN };
const employee: AuthorizationActor = { role: UserRole.EMPLOYEE, employeeId: 'employee-1' };
const supervisor: AuthorizationActor = {
  role: UserRole.SUPERVISOR,
  supervisorScope: [
    { employeeId: 'employee-1', storeId: 'store-1' },
    { employeeId: 'employee-2', storeId: 'store-2' },
  ],
};

describe('authorization policies', () => {
  it('allows Admin all employee and attendance rows', () => {
    expect(canAccessEmployee(admin, { id: 'employee-outside-scope' })).toBe(true);
    expect(
      canAccessAttendance(admin, { employeeId: 'employee-outside-scope', storeId: null }),
    ).toBe(true);
    expect(employeeScopeWhere(admin)).toEqual({});
    expect(attendanceScopeWhere(admin)).toEqual({});
  });

  it('restricts Employee to their own employee and attendance records', () => {
    expect(canAccessEmployee(employee, { id: 'employee-1' })).toBe(true);
    expect(canAccessEmployee(employee, { id: 'employee-2' })).toBe(false);
    expect(canAccessAttendance(employee, { employeeId: 'employee-1', storeId: null })).toBe(true);
    expect(canAccessAttendance(employee, { employeeId: 'employee-2', storeId: 'store-1' })).toBe(
      false,
    );
    expect(employeeScopeWhere(employee)).toEqual({ id: 'employee-1' });
    expect(attendanceScopeWhere(employee)).toEqual({ employeeId: 'employee-1' });
  });

  it('restricts Supervisor to both assigned employee and assigned store', () => {
    expect(canAccessAttendance(supervisor, { employeeId: 'employee-1', storeId: 'store-1' })).toBe(
      true,
    );
    expect(canAccessAttendance(supervisor, { employeeId: 'employee-2', storeId: 'store-2' })).toBe(
      true,
    );
    expect(
      canAccessAttendance(supervisor, { employeeId: 'employee-outside', storeId: 'store-1' }),
    ).toBe(false);
    expect(
      canAccessAttendance(supervisor, { employeeId: 'employee-1', storeId: 'store-outside' }),
    ).toBe(false);
    expect(canAccessAttendance(supervisor, { employeeId: 'employee-1', storeId: 'store-2' })).toBe(
      false,
    );
    expect(canAccessAttendance(supervisor, { employeeId: 'employee-2', storeId: 'store-1' })).toBe(
      false,
    );
    expect(canAccessAttendance(supervisor, { employeeId: 'employee-1', storeId: null })).toBe(
      false,
    );
    expect(attendanceScopeWhere(supervisor)).toEqual({
      OR: [
        { employeeId: 'employee-1', storeId: 'store-1' },
        { employeeId: 'employee-2', storeId: 'store-2' },
      ],
    });
  });

  it('requires a Supervisor employee to have a store assignment inside the trusted store scope', () => {
    expect(
      canAccessEmployee(supervisor, {
        id: 'employee-1',
        storeAssignments: [{ storeId: 'store-1' }],
      }),
    ).toBe(true);
    expect(
      canAccessEmployee(supervisor, {
        id: 'employee-1',
        storeAssignments: [{ storeId: 'store-outside' }],
      }),
    ).toBe(false);
    expect(
      canAccessEmployee(supervisor, {
        id: 'employee-outside',
        storeAssignments: [{ storeId: 'store-1' }],
      }),
    ).toBe(false);
    expect(canAccessEmployee(supervisor, { id: 'employee-1' })).toBe(false);
    expect(employeeScopeWhere(supervisor)).toEqual({
      OR: [
        { id: 'employee-1', storeAssignments: { some: { storeId: 'store-1' } } },
        { id: 'employee-2', storeAssignments: { some: { storeId: 'store-2' } } },
      ],
    });
  });

  it('fails closed when Employee ID or Supervisor scope is missing or empty', () => {
    const employeeWithoutId: AuthorizationActor = { role: UserRole.EMPLOYEE };
    const supervisorWithoutScope: AuthorizationActor = { role: UserRole.SUPERVISOR };
    const supervisorWithEmptyScope: AuthorizationActor = {
      role: UserRole.SUPERVISOR,
      supervisorScope: [],
    };
    const attendance = { employeeId: 'employee-1', storeId: 'store-1' };

    for (const actor of [employeeWithoutId, supervisorWithoutScope, supervisorWithEmptyScope]) {
      expect(canAccessAttendance(actor, attendance)).toBe(false);
      expect(
        canAccessEmployee(actor, { id: 'employee-1', storeAssignments: [{ storeId: 'store-1' }] }),
      ).toBe(false);
      expect(attendanceScopeWhere(actor)).toEqual({ employeeId: { in: [] } });
      expect(employeeScopeWhere(actor)).toEqual({ id: { in: [] } });
    }
  });

  it('fails closed when either half of Supervisor scope is missing or unusable', () => {
    const actors: AuthorizationActor[] = [
      {
        role: UserRole.SUPERVISOR,
        supervisorScope: [{ employeeId: '  ', storeId: 'store-1' }],
      },
      {
        role: UserRole.SUPERVISOR,
        supervisorScope: [{ employeeId: 'employee-1', storeId: ' ' }],
      },
    ];

    for (const actor of actors) {
      expect(canAccessAttendance(actor, { employeeId: 'employee-1', storeId: 'store-1' })).toBe(
        false,
      );
      expect(attendanceScopeWhere(actor)).toEqual({ employeeId: { in: [] } });
    }
  });

  it('keeps requested detail/list/export filters ANDed with authorization scope', () => {
    expect(
      buildAttendanceDetailWhere(supervisor, 'attendance-url-id', {
        employeeId: 'employee-outside',
        storeId: 'store-outside',
      }),
    ).toEqual({
      AND: [
        {
          OR: [
            { employeeId: 'employee-1', storeId: 'store-1' },
            { employeeId: 'employee-2', storeId: 'store-2' },
          ],
        },
        { id: 'attendance-url-id' },
        { employeeId: 'employee-outside', storeId: 'store-outside' },
      ],
    });

    expect(
      buildAttendanceListWhere(employee, {
        employeeId: { in: ['employee-1', 'employee-outside'] },
      }),
    ).toEqual({
      AND: [
        { employeeId: 'employee-1' },
        { employeeId: { in: ['employee-1', 'employee-outside'] } },
      ],
    });

    expect(buildEmployeeDetailWhere(supervisor, 'employee-url-id', { status: 'ACTIVE' })).toEqual({
      AND: [
        {
          OR: [
            { id: 'employee-1', storeAssignments: { some: { storeId: 'store-1' } } },
            { id: 'employee-2', storeAssignments: { some: { storeId: 'store-2' } } },
          ],
        },
        { id: 'employee-url-id' },
        { status: 'ACTIVE' },
      ],
    });

    expect(buildEmployeeListWhere(admin, { status: 'ACTIVE' })).toEqual({
      AND: [{}, { status: 'ACTIVE' }],
    });
  });

  it('throws 403 when guard helpers receive cross-scope IDOR records', () => {
    expect(() =>
      assertCanAccessAttendance(supervisor, {
        employeeId: 'employee-1',
        storeId: 'store-outside',
      }),
    ).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' } satisfies Partial<AppError>),
    );

    expect(() => assertCanAccessEmployee(employee, { id: 'employee-outside' })).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' } satisfies Partial<AppError>),
    );
  });
});
