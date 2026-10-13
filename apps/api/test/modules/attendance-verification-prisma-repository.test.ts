import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { UserRole } from '../../src/generated/prisma/enums.js';
import { PrismaAttendanceVerificationRepository } from '../../src/modules/attendance/prisma-verification-repository.js';
import { PrismaSelfieUploadIntentRepository } from '../../src/modules/attendance/prisma-selfie-upload-repository.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000201';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000202';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000203';
const ATTENDANCE_ID = '00000000-0000-4000-8000-000000000204';
const STORE_ID = '00000000-0000-4000-8000-000000000205';
const OUT_OF_SCOPE_STORE_ID = '00000000-0000-4000-8000-000000000207';
const REQUEST_ID = '00000000-0000-4000-8000-000000000206';
const SERVER_TIME = new Date('2026-10-10T02:00:00.000Z');
const DEVICE_TIME = new Date('2026-10-10T01:59:10.000Z');
const REVIEWED_AT = new Date('2026-10-11T06:00:00.000Z');

const pendingRow = {
  id: ATTENDANCE_ID,
  employeeId: EMPLOYEE_ID,
  storeId: STORE_ID,
  type: 'CHECK_IN',
  serverTime: SERVER_TIME,
  deviceTime: DEVICE_TIME,
  validationStatus: 'PENDING_VERIFICATION',
  employee: { accountId: EMPLOYEE_ID, fullName: 'Karyawan Uji' },
};

function setup(
  options: {
    accessible?: boolean;
    validationStatus?: string;
    updateCount?: number;
    employeeAccountId?: string | null;
  } = {},
) {
  const tx = {
    attendance: {
      findFirst: vi.fn(async (args: unknown) => {
        void args;
        return options.accessible === false
          ? null
          : {
              ...pendingRow,
              validationStatus: options.validationStatus ?? 'PENDING_VERIFICATION',
              employee: {
                ...pendingRow.employee,
                accountId:
                  options.employeeAccountId === undefined
                    ? pendingRow.employee.accountId
                    : options.employeeAccountId,
              },
            };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        void args;
        return { count: options.updateCount ?? 1 };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        void args;
        return {};
      }),
    },
    notification: {
      create: vi.fn(async (args: unknown) => {
        void args;
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
    attendance: {
      findMany: vi.fn(async (args: unknown) => {
        void args;
        return [];
      }),
      findFirst: vi.fn(async (args: unknown) => {
        void args;
        return null;
      }),
    },
  };
  return {
    repository: new PrismaAttendanceVerificationRepository(prisma as never),
    prisma,
    tx,
  };
}

const admin = { userAccountId: ADMIN_ID, role: UserRole.ADMIN } as const;
const supervisor = { userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR } as const;

describe('PrismaAttendanceVerificationRepository', () => {
  it('atomically approves once, writes safe audit and notification, and leaves original timestamps untouched', async () => {
    const { repository, prisma, tx } = setup();

    const result = await repository.decide({
      actor: admin,
      attendanceId: ATTENDANCE_ID,
      decision: 'APPROVED',
      reason: null,
      reviewedAt: REVIEWED_AT,
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({
      attendanceId: ATTENDANCE_ID,
      validationStatus: 'APPROVED',
      reviewedAt: REVIEWED_AT,
      serverTime: SERVER_TIME,
      deviceTime: DEVICE_TIME,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    const update = vi.mocked(tx.attendance.updateMany).mock.calls[0]?.[0] as
      { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
    expect(update?.where).toMatchObject({
      id: ATTENDANCE_ID,
      recordStatus: 'ACTIVE',
      validationStatus: 'PENDING_VERIFICATION',
    });
    expect(update?.data).toEqual({
      validationStatus: 'APPROVED',
      validationReviewedByUserAccountId: ADMIN_ID,
      validationReviewedAt: REVIEWED_AT,
      validationReason: null,
    });
    expect(update?.data).not.toHaveProperty('serverTime');
    expect(update?.data).not.toHaveProperty('deviceTime');
    expect(update?.data).not.toHaveProperty('workDate');
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledTimes(1);

    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({
      actorUserAccountId: ADMIN_ID,
      action: 'attendance.verification.approve',
      entityType: 'attendance',
      entityId: ATTENDANCE_ID,
      beforeData: { validationStatus: 'PENDING_VERIFICATION' },
      afterData: { validationStatus: 'APPROVED', reviewedAt: REVIEWED_AT.toISOString() },
      reason: null,
      requestId: REQUEST_ID,
    });
    const auditJson = JSON.stringify(auditArgs);
    expect(auditJson).not.toContain('latitude');
    expect(auditJson).not.toContain('longitude');
    expect(auditJson).not.toContain('clientIp');
    expect(auditJson).not.toContain('deviceIdHash');
    expect(auditJson).not.toContain('selfie');
    expect(auditJson).not.toContain('signed');

    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        userAccountId: EMPLOYEE_ID,
        kind: 'ATTENDANCE_VERIFICATION',
        title: 'Verifikasi absensi disetujui',
        message: 'Absensi masuk Anda disetujui.',
        payload: { attendanceId: ATTENDANCE_ID, validationStatus: 'APPROVED' },
      },
    });
  });

  it('enforces the assigned Supervisor store relation on queue, detail, and conditional decision', async () => {
    const { repository, prisma, tx } = setup();

    await repository.listPending({ actor: supervisor, skip: 0, take: 10 });
    await repository.findPending({ actor: supervisor, attendanceId: ATTENDANCE_ID });
    await repository.decide({
      actor: supervisor,
      attendanceId: ATTENDANCE_ID,
      decision: 'REJECTED',
      reason: 'Bukti tidak cocok',
      reviewedAt: REVIEWED_AT,
      requestId: REQUEST_ID,
    });

    const expectedStoreScope = {
      is: {
        supervisorAssignments: { some: { supervisorUserAccountId: SUPERVISOR_ID } },
      },
    };
    const listArgs = vi.mocked(prisma.attendance.findMany).mock.calls[0]?.[0] as
      { where: { AND: Array<Record<string, unknown>> } } | undefined;
    expect(listArgs?.where.AND).toContainEqual({ store: expectedStoreScope });
    const detailArgs = vi.mocked(prisma.attendance.findFirst).mock.calls[0]?.[0] as
      { where: Record<string, unknown> } | undefined;
    expect(detailArgs?.where.store).toEqual(expectedStoreScope);
    const decisionFindArgs = vi.mocked(tx.attendance.findFirst).mock.calls[0]?.[0] as
      { where: Record<string, unknown> } | undefined;
    expect(decisionFindArgs?.where.store).toEqual(expectedStoreScope);
    const updateArgs = vi.mocked(tx.attendance.updateMany).mock.calls[0]?.[0] as
      { where: Record<string, unknown> } | undefined;
    expect(updateArgs?.where.store).toEqual(expectedStoreScope);
    expect(updateArgs?.where).not.toHaveProperty('employeeId');
    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({
      actorUserAccountId: SUPERVISOR_ID,
      action: 'attendance.verification.reject',
      entityType: 'attendance',
      entityId: ATTENDANCE_ID,
      beforeData: { validationStatus: 'PENDING_VERIFICATION' },
      afterData: { validationStatus: 'REJECTED', reviewedAt: REVIEWED_AT.toISOString() },
      reason: 'Bukti tidak cocok',
      requestId: REQUEST_ID,
    });
  });

  it('ANDs a caller-selected store filter with the Supervisor session assignment scope', async () => {
    const { repository, prisma } = setup();

    await repository.listPending({
      actor: supervisor,
      storeId: OUT_OF_SCOPE_STORE_ID,
      skip: 0,
      take: 10,
    });

    const args = vi.mocked(prisma.attendance.findMany).mock.calls[0]?.[0] as
      { where: { AND: Array<Record<string, unknown>> } } | undefined;
    expect(args?.where.AND).toEqual([
      { validationStatus: 'PENDING_VERIFICATION', recordStatus: 'ACTIVE' },
      {
        store: {
          is: {
            supervisorAssignments: { some: { supervisorUserAccountId: SUPERVISOR_ID } },
          },
        },
      },
      { storeId: OUT_OF_SCOPE_STORE_ID },
    ]);
    expect(JSON.stringify(args?.where)).not.toContain('employeeId');
    expect(JSON.stringify(args?.where)).not.toContain('latitude');
  });

  it('fails closed on cross-store and null-store detail via the assignment relation filter', async () => {
    const { repository, prisma } = setup({ accessible: false });

    await expect(
      repository.findPending({ actor: supervisor, attendanceId: ATTENDANCE_ID }),
    ).resolves.toBeNull();
    const args = vi.mocked(prisma.attendance.findFirst).mock.calls[0]?.[0] as
      { where: Record<string, unknown> } | undefined;
    expect(args?.where.store).toEqual({
      is: { supervisorAssignments: { some: { supervisorUserAccountId: SUPERVISOR_ID } } },
    });
    expect(args?.where).not.toHaveProperty('OR');
  });

  it('returns 404 without side effects when the scoped attendance is absent', async () => {
    const { repository, tx } = setup({ accessible: false });

    await expect(
      repository.decide({
        actor: supervisor,
        attendanceId: ATTENDANCE_ID,
        decision: 'APPROVED',
        reason: null,
        reviewedAt: REVIEWED_AT,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ATTENDANCE_VERIFICATION_NOT_FOUND' });
    expect(tx.attendance.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('does not route a notification to the reviewer or include personal evidence when employee account is null', async () => {
    const { repository, tx } = setup({ employeeAccountId: null });

    await repository.decide({
      actor: supervisor,
      attendanceId: ATTENDANCE_ID,
      decision: 'REJECTED',
      reason: 'Bukti perlu koreksi',
      reviewedAt: REVIEWED_AT,
      requestId: REQUEST_ID,
    });

    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(auditArgs?.data).toMatchObject({ actorUserAccountId: SUPERVISOR_ID });
    expect(JSON.stringify(auditArgs)).not.toContain(EMPLOYEE_ID);
    expect(JSON.stringify(auditArgs)).not.toContain('Karyawan Uji');
    expect(JSON.stringify(auditArgs)).not.toContain('latitude');
    expect(JSON.stringify(auditArgs)).not.toContain('longitude');
    expect(JSON.stringify(auditArgs)).not.toContain('deviceIdHash');
    expect(JSON.stringify(auditArgs)).not.toContain('selfie');
  });

  it('rejects decision replay after the record is no longer pending', async () => {
    const { repository, tx } = setup({ validationStatus: 'APPROVED' });

    await expect(
      repository.decide({
        actor: admin,
        attendanceId: ATTENDANCE_ID,
        decision: 'APPROVED',
        reason: null,
        reviewedAt: REVIEWED_AT,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ATTENDANCE_VERIFICATION_CONFLICT' });
    expect(tx.attendance.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('handles a concurrent conditional-update conflict without writing audit or notification', async () => {
    const { repository, tx } = setup({ updateCount: 0 });

    await expect(
      repository.decide({
        actor: admin,
        attendanceId: ATTENDANCE_ID,
        decision: 'REJECTED',
        reason: 'Alasan wajib tercatat',
        reviewedAt: REVIEWED_AT,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ATTENDANCE_VERIFICATION_CONFLICT' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('restricts Supervisor history to assigned non-null stores', async () => {
    const { repository, prisma } = setup();
    await repository.listHistory({
      actor: supervisor,
      employeeId: EMPLOYEE_ID,
      before: SERVER_TIME,
      excludeAttendanceId: ATTENDANCE_ID,
      take: 10,
    });
    const args = vi.mocked(prisma.attendance.findMany).mock.calls[0]?.[0] as
      { where: Record<string, unknown> } | undefined;
    expect(args?.where.store).toEqual({
      is: { supervisorAssignments: { some: { supervisorUserAccountId: SUPERVISOR_ID } } },
    });
    expect(args?.where).toMatchObject({ employeeId: EMPLOYEE_ID, serverTime: { lt: SERVER_TIME } });
  });
});

describe('PrismaSelfieUploadIntentRepository review scope', () => {
  it('requires an assigned store and still-pending attendance before creating a Supervisor read URL', async () => {
    const findFirst = vi.fn(async (args: unknown) => {
      void args;
      return null;
    });
    const repository = new PrismaSelfieUploadIntentRepository({
      selfieUploadIntent: { findFirst },
    } as never);

    await repository.findAttachedObjectForAttempt({
      attemptId: ATTENDANCE_ID,
      now: REVIEWED_AT,
      supervisorUserAccountId: SUPERVISOR_ID,
    });

    const args = findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> } | undefined;
    expect(args?.where).toMatchObject({
      attachedAttempt: {
        is: {
          attendance: {
            is: {
              validationStatus: 'PENDING_VERIFICATION',
              store: {
                is: {
                  supervisorAssignments: {
                    some: { supervisorUserAccountId: SUPERVISOR_ID },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(args?.where.attachedAttempt).not.toBeNull();
  });
});
