import { describe, expect, it, vi } from 'vitest';

import { RequestStatus, RequestType, UserRole } from '../../src/generated/prisma/enums.js';
import {
  PrismaAttendanceRequestRepository,
  deriveUniqueScheduledStore,
} from '../../src/modules/attendance-requests/prisma-repository.js';
import type { RequestDecision } from '../../src/modules/attendance-requests/index.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000201';
const REQUEST_ID = '00000000-0000-4000-8000-000000000202';
const ADMIN_ID = '00000000-0000-4000-8000-000000000203';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000204';
const STORE_A = '00000000-0000-4000-8000-000000000205';
const STORE_B = '00000000-0000-4000-8000-000000000206';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000210';
const OTHER_REQUEST_ID = '00000000-0000-4000-8000-000000000211';
const RANDOM_REQUEST_ID = '00000000-0000-4000-8000-000000000212';
const START = new Date('2026-10-12T00:00:00.000Z'); // Monday
const END = new Date('2026-10-16T00:00:00.000Z'); // Friday

function assignment(storeId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    storeId,
    effectiveFrom: START,
    effectiveTo: END,
    workShift: { workDays: [1, 2, 3, 4, 5] },
    ...overrides,
  };
}

function scopedRow(options: {
  assignments?: ReturnType<typeof assignment>[];
  employeeStoreIds?: string[];
  requestType?: RequestType;
  status?: RequestStatus;
}) {
  return {
    id: REQUEST_ID,
    employeeId: EMPLOYEE_ID,
    requestType: options.requestType ?? RequestType.LEAVE,
    startDate: START,
    endDate: END,
    reason: 'Pengajuan uji',
    attachmentObjectKey: null,
    requestedOvertimeMinutes: options.requestType === RequestType.OVERTIME ? 75 : null,
    status: options.status ?? RequestStatus.PENDING,
    approverUserAccountId: null,
    decisionAt: null,
    decisionNote: null,
    requestedAt: START,
    employee: {
      accountId: EMPLOYEE_ID,
      fullName: 'Karyawan Uji',
      storeAssignments: (options.employeeStoreIds ?? [STORE_A]).map((storeId) => ({ storeId })),
      shiftAssignments: options.assignments ?? [assignment(STORE_A)],
    },
    approver: null,
  };
}

function decisionHarness(
  options: {
    row?: ReturnType<typeof scopedRow>;
    allowedStoreIds?: string[];
    updateCount?: number;
    scopeCandidateFound?: boolean;
  } = {},
) {
  const row = options.row ?? scopedRow({});
  const events: string[] = [];
  let updated = false;
  const scopeRow = {
    id: row.id,
    requestType: row.requestType,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    employee: {
      storeAssignments: row.employee.storeAssignments,
      shiftAssignments: row.employee.shiftAssignments,
    },
  };
  const tx = {
    attendanceRequest: {
      findFirst: vi.fn(async (args: { select: Record<string, unknown> }) => {
        events.push('attendanceRequest.findFirst');
        const isScopeOnly = !('reason' in args.select) && !('attachmentObjectKey' in args.select);
        if (isScopeOnly) {
          return options.scopeCandidateFound === false ? null : scopeRow;
        }
        return row;
      }),
      updateMany: vi.fn(async () => {
        events.push('attendanceRequest.updateMany');
        const count = options.updateCount ?? 1;
        if (count === 1) updated = true;
        return { count };
      }),
      findUnique: vi.fn(async () => {
        events.push('attendanceRequest.findUnique');
        return updated
          ? {
              ...row,
              status: RequestStatus.APPROVED,
              approverUserAccountId: SUPERVISOR_ID,
              approver: { role: UserRole.SUPERVISOR },
            }
          : row;
      }),
    },
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => {
        events.push('supervisorStoreAssignment.findMany');
        return (options.allowedStoreIds ?? [STORE_A]).map((storeId) => ({ storeId }));
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        void args;
        events.push('auditLog.create');
        return {};
      }),
    },
    notification: {
      create: vi.fn(async (args: unknown) => {
        void args;
        events.push('notification.create');
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return { repository: new PrismaAttendanceRequestRepository(prisma as never), tx, events };
}

function createHarness() {
  const row = scopedRow({});
  const tx = {
    $queryRaw: vi.fn(async () => []),
    employee: {
      findFirst: vi.fn(async () => ({
        storeAssignments: [{ storeId: STORE_A }],
        shiftAssignments: [assignment(STORE_A)],
      })),
    },
    attendanceRequest: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => row),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        void args;
        return {};
      }),
    },
    userAccount: { findMany: vi.fn(async () => [{ id: ADMIN_ID }]) },
    notification: {
      createMany: vi.fn(async (args: unknown) => {
        void args;
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return { repository: new PrismaAttendanceRequestRepository(prisma as never), prisma, tx };
}

function accessHarness(row: ReturnType<typeof scopedRow>) {
  const prisma = {
    attendanceRequest: { findFirst: vi.fn(async () => row) },
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => [{ storeId: STORE_A }]),
    },
  };
  return { repository: new PrismaAttendanceRequestRepository(prisma as never), prisma };
}

function listHarness(rows: ReturnType<typeof scopedRow>[]) {
  const prisma = {
    attendanceRequest: { findMany: vi.fn(async () => rows) },
    supervisorStoreAssignment: {
      findMany: vi.fn(async () => [{ storeId: STORE_A }]),
    },
  };
  return { repository: new PrismaAttendanceRequestRepository(prisma as never), prisma };
}

function supervisorActor() {
  return { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR, employeeId: null } as const;
}

function decideInput(
  actor: { userAccountId: string; role: UserRole; employeeId: string | null } = supervisorActor(),
  decision: RequestDecision = RequestStatus.APPROVED,
) {
  return {
    actor,
    requestId: REQUEST_ID,
    decision,
    decisionNote: 'Ditinjau.',
    decidedAt: START,
    auditRequestId: '00000000-0000-4000-8000-000000000207',
  } as const;
}

describe('PrismaAttendanceRequestRepository', () => {
  it('atomically notifies active Admin accounts of a new request without copying its private reason', async () => {
    const { repository, prisma, tx } = createHarness();

    await repository.create({
      id: REQUEST_ID,
      actor: { userAccountId: EMPLOYEE_ID, role: UserRole.EMPLOYEE, employeeId: EMPLOYEE_ID },
      requestType: RequestType.LEAVE,
      startDate: START,
      endDate: END,
      reason: 'PRIVATE_REQUEST_REASON_SENTINEL',
      attachmentObjectKey: 'private/attachment-key',
      requestedOvertimeMinutes: null,
      requestId: '00000000-0000-4000-8000-000000000209',
    });

    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({
      actorUserAccountId: EMPLOYEE_ID,
      action: 'attendance_request.create',
      entityType: 'attendance_request',
      entityId: REQUEST_ID,
      afterData: { requestType: RequestType.LEAVE, status: RequestStatus.PENDING },
      reason: 'Pengajuan dibuat oleh karyawan.',
      requestId: '00000000-0000-4000-8000-000000000209',
    });
    expect(JSON.stringify(auditArgs)).not.toContain('private/attachment-key');

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(tx.userAccount.findMany).toHaveBeenCalledWith({
      where: { role: UserRole.ADMIN, status: 'ACTIVE' },
      select: { id: true },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          userAccountId: ADMIN_ID,
          kind: 'ATTENDANCE_REQUEST',
          title: 'Pengajuan baru perlu ditinjau',
          message: 'Ada pengajuan karyawan yang menunggu peninjauan.',
          payload: { attendanceRequestId: REQUEST_ID, requestType: RequestType.LEAVE },
        },
      ],
    });
    const serializedEvent = JSON.stringify(
      vi.mocked(tx.notification.createMany).mock.calls[0]?.[0],
    );
    expect(serializedEvent).not.toContain('PRIVATE_REQUEST_REASON_SENTINEL');
    expect(serializedEvent).not.toContain('private/attachment-key');
  });

  it('derives a reviewer store only from a unique scheduled store and employee assignment', () => {
    expect(deriveUniqueScheduledStore([assignment(STORE_A)], [STORE_A], START, END)).toBe(STORE_A);
    expect(deriveUniqueScheduledStore([assignment(STORE_A)], [], START, END)).toBeNull();
    expect(deriveUniqueScheduledStore([assignment(null)], [STORE_A], START, END)).toBeNull();
    expect(
      deriveUniqueScheduledStore(
        [assignment(STORE_A), assignment(STORE_B)],
        [STORE_A, STORE_B],
        START,
        END,
      ),
    ).toBeNull();
    expect(
      deriveUniqueScheduledStore(
        [assignment(STORE_A, { effectiveFrom: new Date('2026-10-20') })],
        [STORE_A],
        START,
        END,
      ),
    ).toBeNull();
  });

  it('scopes an Employee findAccessible query to the employee id from the principal', async () => {
    const otherRow = { ...scopedRow({}), id: OTHER_REQUEST_ID, employeeId: OTHER_EMPLOYEE_ID };
    const prisma = {
      attendanceRequest: {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
          args.where.id === otherRow.id && args.where.employeeId === otherRow.employeeId
            ? otherRow
            : null,
        ),
      },
    };
    const repository = new PrismaAttendanceRequestRepository(prisma as never);

    await expect(
      repository.findAccessible({
        actor: { userAccountId: EMPLOYEE_ID, role: UserRole.EMPLOYEE, employeeId: EMPLOYEE_ID },
        requestId: OTHER_REQUEST_ID,
      }),
    ).resolves.toBeNull();
    expect(prisma.attendanceRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: OTHER_REQUEST_ID, employeeId: EMPLOYEE_ID }),
      }),
    );
  });

  it('checks Supervisor assignment before a scope-only candidate query and hides out-of-scope IDs as not found', async () => {
    const outOfStore = decisionHarness({
      row: scopedRow({
        status: RequestStatus.APPROVED,
        assignments: [assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
      scopeCandidateFound: false,
    });
    const random = decisionHarness({ scopeCandidateFound: false });
    const outOfStoreError = await outOfStore.repository
      .decide(decideInput())
      .catch((error: { statusCode: number; code: string; message: string }) => ({
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      }));
    const randomError = await random.repository
      .decide({ ...decideInput(), requestId: RANDOM_REQUEST_ID })
      .catch((error: { statusCode: number; code: string; message: string }) => ({
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      }));

    expect(outOfStoreError).toEqual({
      statusCode: 404,
      code: 'ATTENDANCE_REQUEST_NOT_FOUND',
      message: 'Pengajuan tidak ditemukan.',
    });
    expect(randomError).toEqual(outOfStoreError);
    expect(outOfStore.events).toEqual([
      'supervisorStoreAssignment.findMany',
      'attendanceRequest.findFirst',
    ]);
    const candidateQuery = vi.mocked(outOfStore.tx.attendanceRequest.findFirst).mock.calls[0]?.[0];
    expect(candidateQuery).toMatchObject({
      where: {
        id: REQUEST_ID,
        requestType: { in: expect.any(Array) },
        employee: {
          shiftAssignments: { some: { storeId: { in: [STORE_A] } } },
        },
      },
    });
    expect(candidateQuery?.select).toEqual({
      id: true,
      requestType: true,
      startDate: true,
      endDate: true,
      status: true,
      employee: {
        select: {
          storeAssignments: { select: { storeId: true } },
          shiftAssignments: {
            select: {
              storeId: true,
              effectiveFrom: true,
              effectiveTo: true,
              workShift: { select: { workDays: true } },
            },
          },
        },
      },
    });
    expect(JSON.stringify(candidateQuery?.select)).not.toMatch(
      /fullName|accountId|reason|attachmentObjectKey|decisionNote/i,
    );
    for (const { tx } of [outOfStore, random]) {
      expect(tx.attendanceRequest.findUnique).not.toHaveBeenCalled();
      expect(tx.attendanceRequest.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.notification.create).not.toHaveBeenCalled();
    }
  });

  it('returns the documented Admin-required denial for an ambiguous schedule without reading request details', async () => {
    const { repository, tx, events } = decisionHarness({
      row: scopedRow({
        status: RequestStatus.APPROVED,
        assignments: [assignment(STORE_A), assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
    });

    await expect(repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 403,
      code: 'REQUEST_REQUIRES_ADMIN',
    });
    expect(events).toEqual(['supervisorStoreAssignment.findMany', 'attendanceRequest.findFirst']);
    expect(tx.attendanceRequest.findUnique).not.toHaveBeenCalled();
    expect(tx.attendanceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('preserves an authorized Supervisor decision flow and loads details only after scope proof', async () => {
    const { repository, tx, events } = decisionHarness();

    await repository.decide(decideInput());

    expect(events).toEqual([
      'supervisorStoreAssignment.findMany',
      'attendanceRequest.findFirst',
      'attendanceRequest.findUnique',
      'attendanceRequest.updateMany',
      'auditLog.create',
      'notification.create',
      'attendanceRequest.findUnique',
    ]);
    expect(tx.attendanceRequest.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: REQUEST_ID },
      select: expect.objectContaining({
        reason: true,
        attachmentObjectKey: true,
        employee: { select: { fullName: true, accountId: true } },
      }),
    });
    expect(tx.attendanceRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({
      actorUserAccountId: SUPERVISOR_ID,
      action: 'attendance_request.approve',
      entityType: 'attendance_request',
      entityId: REQUEST_ID,
      beforeData: { status: RequestStatus.PENDING },
      afterData: { status: RequestStatus.APPROVED, requestType: RequestType.LEAVE },
      reason: 'Ditinjau.',
      requestId: '00000000-0000-4000-8000-000000000207',
    });
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
  });

  it('records an explicit rejection event with the decision reason', async () => {
    const { repository, tx } = decisionHarness();

    await repository.decide(decideInput(supervisorActor(), RequestStatus.REJECTED));

    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({
      actorUserAccountId: SUPERVISOR_ID,
      action: 'attendance_request.reject',
      entityType: 'attendance_request',
      entityId: REQUEST_ID,
      beforeData: { status: RequestStatus.PENDING },
      afterData: { status: RequestStatus.REJECTED, requestType: RequestType.LEAVE },
      reason: 'Ditinjau.',
      requestId: '00000000-0000-4000-8000-000000000207',
    });
  });

  it('requires Admin for in-scope Supervisor overtime decisions without changing status or auditing', async () => {
    const { repository, tx } = decisionHarness({
      row: scopedRow({ requestType: RequestType.OVERTIME }),
    });
    await expect(repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 403,
      code: 'REQUEST_REQUIRES_ADMIN',
    });
    expect(tx.attendanceRequest.findUnique).not.toHaveBeenCalled();
    expect(tx.attendanceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('hides a clearly out-of-assignment Supervisor decision as not found without reading details', async () => {
    const { repository, tx } = decisionHarness({
      row: scopedRow({
        requestType: RequestType.OVERTIME,
        assignments: [assignment(STORE_A)],
        employeeStoreIds: [STORE_A],
      }),
      allowedStoreIds: [STORE_B],
      scopeCandidateFound: false,
    });
    await expect(repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 404,
      code: 'ATTENDANCE_REQUEST_NOT_FOUND',
    });
    expect(tx.attendanceRequest.findUnique).not.toHaveBeenCalled();
    expect(tx.attendanceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('hides global schedules without an assigned-store candidate and routes ambiguous schedules to Admin', async () => {
    const global = decisionHarness({
      row: scopedRow({ requestType: RequestType.OVERTIME, assignments: [assignment(null)] }),
      scopeCandidateFound: false,
    });
    await expect(global.repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 404,
      code: 'ATTENDANCE_REQUEST_NOT_FOUND',
    });

    const ambiguous = decisionHarness({
      row: scopedRow({
        requestType: RequestType.OVERTIME,
        assignments: [assignment(STORE_A), assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
    });
    await expect(ambiguous.repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 403,
      code: 'REQUEST_REQUIRES_ADMIN',
    });
    for (const { tx } of [global, ambiguous]) {
      expect(tx.attendanceRequest.findUnique).not.toHaveBeenCalled();
      expect(tx.attendanceRequest.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.notification.create).not.toHaveBeenCalled();
    }
  });

  it('lets a scoped Supervisor view in-scope overtime but hides cross-store and ambiguous overtime', async () => {
    const inScope = accessHarness(scopedRow({ requestType: RequestType.OVERTIME }));
    await expect(
      inScope.repository.findAccessible({ actor: supervisorActor(), requestId: REQUEST_ID }),
    ).resolves.toMatchObject({ requestType: RequestType.OVERTIME });
    expect(inScope.prisma.attendanceRequest.findFirst).toHaveBeenCalledTimes(1);

    const outOfScope = accessHarness(
      scopedRow({
        requestType: RequestType.OVERTIME,
        assignments: [assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
    );
    await expect(
      outOfScope.repository.findAccessible({ actor: supervisorActor(), requestId: REQUEST_ID }),
    ).resolves.toBeNull();

    for (const assignments of [[assignment(null)], [assignment(STORE_A), assignment(STORE_B)]]) {
      const ambiguous = accessHarness(
        scopedRow({ requestType: RequestType.OVERTIME, assignments }),
      );
      await expect(
        ambiguous.repository.findAccessible({ actor: supervisorActor(), requestId: REQUEST_ID }),
      ).resolves.toBeNull();
    }
  });

  it('lists only uniquely in-scope overtime requests for a Supervisor', async () => {
    const { repository } = listHarness([
      scopedRow({ requestType: RequestType.OVERTIME }),
      scopedRow({
        requestType: RequestType.OVERTIME,
        assignments: [assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
      scopedRow({ requestType: RequestType.OVERTIME, assignments: [assignment(null)] }),
      scopedRow({
        requestType: RequestType.OVERTIME,
        assignments: [assignment(STORE_A), assignment(STORE_B)],
        employeeStoreIds: [STORE_A, STORE_B],
      }),
    ]);

    const result = await repository.list({ actor: supervisorActor(), skip: 0, take: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.requestType).toBe(RequestType.OVERTIME);
    expect(result.hasNextPage).toBe(false);
  });

  it('lets Admin approve overtime even on an ambiguous schedule and retains PENDING-only update', async () => {
    const { repository, tx } = decisionHarness({
      row: scopedRow({ requestType: RequestType.OVERTIME, assignments: [assignment(null)] }),
    });
    await repository.decide(
      decideInput({ userAccountId: ADMIN_ID, role: UserRole.ADMIN, employeeId: null }),
    );
    expect(tx.attendanceRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RequestStatus.PENDING }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        userAccountId: EMPLOYEE_ID,
        kind: 'REQUEST_DECISION',
        title: 'Pengajuan lembur disetujui',
        message: 'Pengajuan lembur Anda disetujui.',
        payload: { attendanceRequestId: REQUEST_ID, status: RequestStatus.APPROVED },
      },
    });
    expect(JSON.stringify(vi.mocked(tx.notification.create).mock.calls[0]?.[0])).not.toContain(
      'Pengajuan uji',
    );
  });

  it('returns no employee request when the session has no linked employee profile', async () => {
    const prisma = {
      attendanceRequest: { findFirst: vi.fn(async () => scopedRow({})) },
      supervisorStoreAssignment: { findMany: vi.fn(async () => []) },
    };
    const repository = new PrismaAttendanceRequestRepository(prisma as never);

    await expect(
      repository.findAccessible({
        actor: {
          userAccountId: '00000000-0000-4000-8000-000000000208',
          role: UserRole.EMPLOYEE,
          employeeId: null,
        },
        requestId: REQUEST_ID,
      }),
    ).resolves.toBeNull();
    expect(prisma.attendanceRequest.findFirst).not.toHaveBeenCalled();
  });

  it('rejects replayed decisions and does not audit a failed compare-and-set', async () => {
    const { repository, tx } = decisionHarness({ updateCount: 0 });
    await expect(repository.decide(decideInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'ATTENDANCE_REQUEST_DECISION_CONFLICT',
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
});
