import { UserRole } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';

/**
 * One employee/store pair resolved from a trusted server-side supervisor-assignment source.
 * Keep pairs intact: two independent ID lists could accidentally authorize their cross-product.
 */
export type TrustedSupervisorAssignment = {
  readonly employeeId: string;
  readonly storeId: string;
};

/** Trusted assignment pairs resolved by the server, never copied from request input. */
export type TrustedSupervisorScope = readonly TrustedSupervisorAssignment[];

/**
 * Authorization context for policies. Construct only from a verified session and, for
 * supervisors, current employee/store assignment pairs loaded by the server from a trusted
 * source. The current schema has no supervisor-assignment model; do not infer these pairs
 * from EmployeeStore.assignedByUserAccountId, which records who created an employee/store
 * link. Never populate role, employeeId, or supervisorScope from request input.
 */
export type AuthorizationActor =
  | { readonly role: typeof UserRole.ADMIN }
  | {
      readonly role: typeof UserRole.SUPERVISOR;
      readonly supervisorScope?: TrustedSupervisorScope | null;
    }
  | { readonly role: typeof UserRole.EMPLOYEE; readonly employeeId?: string | null };

export type EmployeeAccessRecord = {
  readonly id: string;
  readonly storeAssignments?: readonly { readonly storeId: string }[];
};

export type AttendanceAccessRecord = {
  readonly employeeId: string;
  readonly storeId: string | null;
};

const noEmployeeAccessWhere = (): Prisma.EmployeeWhereInput => ({ id: { in: [] } });
const noAttendanceAccessWhere = (): Prisma.AttendanceWhereInput => ({ employeeId: { in: [] } });

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function usableAssignments(
  values: TrustedSupervisorScope | null | undefined,
): TrustedSupervisorAssignment[] {
  return (
    values?.filter(
      (assignment): assignment is TrustedSupervisorAssignment =>
        assignment !== null &&
        typeof assignment === 'object' &&
        isUsableId(assignment.employeeId) &&
        isUsableId(assignment.storeId),
    ) ?? []
  );
}

/**
 * Mandatory employee-row scope for list and export queries. Combine with user filters
 * through buildEmployeeListWhere/buildEmployeeDetailWhere; do not spread over this policy.
 * `actor` must come from a verified session and trusted server-side DB assignment data.
 */
export function employeeScopeWhere(actor: AuthorizationActor): Prisma.EmployeeWhereInput {
  switch (actor.role) {
    case UserRole.ADMIN:
      return {};
    case UserRole.EMPLOYEE:
      return isUsableId(actor.employeeId) ? { id: actor.employeeId } : noEmployeeAccessWhere();
    case UserRole.SUPERVISOR: {
      const assignments = usableAssignments(actor.supervisorScope);
      if (assignments.length === 0) return noEmployeeAccessWhere();

      return {
        OR: assignments.map(({ employeeId, storeId }) => ({
          id: employeeId,
          storeAssignments: { some: { storeId } },
        })),
      };
    }
    default:
      return noEmployeeAccessWhere();
  }
}

/**
 * Mandatory attendance-row scope for list and export queries. Supervisor rows require
 * an exact assigned employee/store pair; cross-pair and null-store rows fail closed.
 * `actor` must come from a verified session and trusted server-side DB assignment data.
 */
export function attendanceScopeWhere(actor: AuthorizationActor): Prisma.AttendanceWhereInput {
  switch (actor.role) {
    case UserRole.ADMIN:
      return {};
    case UserRole.EMPLOYEE:
      return isUsableId(actor.employeeId)
        ? { employeeId: actor.employeeId }
        : noAttendanceAccessWhere();
    case UserRole.SUPERVISOR: {
      const assignments = usableAssignments(actor.supervisorScope);
      if (assignments.length === 0) return noAttendanceAccessWhere();

      return {
        OR: assignments.map(({ employeeId, storeId }) => ({ employeeId, storeId })),
      };
    }
    default:
      return noAttendanceAccessWhere();
  }
}

/**
 * Scope-safe employee list/export where clause. Caller filters are ANDed with the policy
 * so they cannot replace or broaden it. `actor` must be server-verified.
 */
export function buildEmployeeListWhere(
  actor: AuthorizationActor,
  requestedWhere: Prisma.EmployeeWhereInput = {},
): Prisma.EmployeeWhereInput {
  return { AND: [employeeScopeWhere(actor), requestedWhere] };
}

/**
 * Scope-safe employee detail where clause; a URL ID can only narrow the policy result.
 * `actor` must be server-verified and its scope loaded from trusted DB assignments.
 */
export function buildEmployeeDetailWhere(
  actor: AuthorizationActor,
  employeeId: string,
  requestedWhere: Prisma.EmployeeWhereInput = {},
): Prisma.EmployeeWhereInput {
  return { AND: [employeeScopeWhere(actor), { id: employeeId }, requestedWhere] };
}

/**
 * Scope-safe attendance list/export where clause. Use this for exports as well as lists
 * so filters and pagination never bypass row-level scope. `actor` must be server-verified.
 */
export function buildAttendanceListWhere(
  actor: AuthorizationActor,
  requestedWhere: Prisma.AttendanceWhereInput = {},
): Prisma.AttendanceWhereInput {
  return { AND: [attendanceScopeWhere(actor), requestedWhere] };
}

/**
 * Scope-safe attendance detail where clause; a URL ID is always ANDed with actor scope.
 * `actor` must be server-verified and its scope loaded from trusted DB assignments.
 */
export function buildAttendanceDetailWhere(
  actor: AuthorizationActor,
  attendanceId: string,
  requestedWhere: Prisma.AttendanceWhereInput = {},
): Prisma.AttendanceWhereInput {
  return { AND: [attendanceScopeWhere(actor), { id: attendanceId }, requestedWhere] };
}

/**
 * Pure employee-row access check for already-loaded rows. Supervisor rows require a
 * matching employee ID and at least one matching assigned store. Load assignments using
 * a scoped query first; do not use this as a substitute for query filters in list/export.
 */
export function canAccessEmployee(
  actor: AuthorizationActor,
  employee: EmployeeAccessRecord,
): boolean {
  switch (actor.role) {
    case UserRole.ADMIN:
      return true;
    case UserRole.EMPLOYEE:
      return isUsableId(actor.employeeId) && employee.id === actor.employeeId;
    case UserRole.SUPERVISOR: {
      const assignments = usableAssignments(actor.supervisorScope);
      return assignments.some(
        (assignment) =>
          assignment.employeeId === employee.id &&
          (employee.storeAssignments?.some(({ storeId }) => storeId === assignment.storeId) ??
            false),
      );
    }
    default:
      return false;
  }
}

/** Pure attendance-row check; a supervisor cannot access rows without a store. */
export function canAccessAttendance(
  actor: AuthorizationActor,
  attendance: AttendanceAccessRecord,
): boolean {
  switch (actor.role) {
    case UserRole.ADMIN:
      return true;
    case UserRole.EMPLOYEE:
      return isUsableId(actor.employeeId) && attendance.employeeId === actor.employeeId;
    case UserRole.SUPERVISOR: {
      return usableAssignments(actor.supervisorScope).some(
        (assignment) =>
          attendance.storeId !== null &&
          assignment.employeeId === attendance.employeeId &&
          assignment.storeId === attendance.storeId,
      );
    }
    default:
      return false;
  }
}

/** Throws a 403 when a loaded employee row is outside the verified actor's policy scope. */
export function assertCanAccessEmployee(
  actor: AuthorizationActor,
  employee: EmployeeAccessRecord,
): void {
  if (!canAccessEmployee(actor, employee)) {
    throw new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses ke data ini.');
  }
}

/** Throws a 403 when a loaded attendance row is outside the verified actor's policy scope. */
export function assertCanAccessAttendance(
  actor: AuthorizationActor,
  attendance: AttendanceAccessRecord,
): void {
  if (!canAccessAttendance(actor, attendance)) {
    throw new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses ke data ini.');
  }
}
