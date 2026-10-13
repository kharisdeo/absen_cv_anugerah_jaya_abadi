import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import {
  AttendanceValidationStatus,
  NetworkStatus,
  UserRole,
  ValidationMethod,
} from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { CreateAttendanceAttemptData } from '../../src/modules/attendance/index.js';
import { PrismaAttendanceAttemptRepository } from '../../src/modules/attendance/prisma-repository.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000021';
const BINDING_ID = '00000000-0000-4000-8000-000000000022';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000023';
const ADMIN_ACCOUNT_ID = '00000000-0000-4000-8000-000000000030';
const STORE_ID = '00000000-0000-4000-8000-000000000026';
const SHIFT_ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000028';
const ATTENDANCE_ID = '00000000-0000-4000-8000-000000000029';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000024';
const receivedAt = new Date('2026-10-11T03:00:00.000Z');

const data: CreateAttendanceAttemptData = {
  actor: {
    userAccountId: ACCOUNT_ID,
    role: UserRole.EMPLOYEE,
    employeeId: EMPLOYEE_ID,
    deviceBindingId: BINDING_ID,
  },
  idempotencyKey: IDEMPOTENCY_KEY,
  requestFingerprint: 'a'.repeat(64),
  storeIdHint: null,
  type: 'CHECK_IN',
  clientRecordedAt: new Date('2026-10-11T03:00:00.000Z'),
  networkStatus: 'ONLINE',
  reportedMethod: 'GPS',
  latitude: -6.2,
  longitude: 106.8,
  accuracyMeters: 12.5,
  selfieReferenceHash: 'b'.repeat(64),
  selfieStagedObjectKey: 'attendance/selfie-staging/source',
  selfieSealedObjectKey: 'attendance/selfie-accepted/sealed',
  selfieSizeBytes: 10 * 1024,
  selfieRetentionExpiresAt: new Date('2027-10-11T03:00:00.000Z'),
  livenessFaceDetectedClaim: true,
  livenessPassedClaim: true,
  clientIp: '192.0.2.1',
  requestId: 'request-under-test',
};

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { target: ['employee_id', 'idempotency_key'] },
  });
}

function setup(
  options: {
    duplicateOnCreate?: boolean;
    winnerExists?: boolean;
    receivedAt?: Date;
    duplicateCheckIn?: boolean;
    shiftAssignments?: ReadonlyArray<{
      id: string;
      storeId: string | null;
      startTime: string;
      endTime: string;
      lateToleranceMinutes: number;
      workDays: number[];
    }>;
    openCheckIns?: ReadonlyArray<{
      id: string;
      shiftAssignmentId: string | null;
      workDate: string;
      serverTime: Date;
      validationStatus:
        'VALID' | 'PENDING_VERIFICATION' | 'APPROVED' | 'REJECTED' | 'PENDING_OFFLINE';
      recordStatus: 'ACTIVE' | 'SUPERSEDED';
      storeId: string | null;
    }>;
    openCheckInsByDate?: Readonly<
      Record<
        string,
        ReadonlyArray<{
          id: string;
          shiftAssignmentId: string | null;
          workDate: string;
          serverTime: Date;
          validationStatus:
            'VALID' | 'PENDING_VERIFICATION' | 'APPROVED' | 'REJECTED' | 'PENDING_OFFLINE';
          recordStatus: 'ACTIVE' | 'SUPERSEDED';
          storeId: string | null;
        }>
      >
    >;
    approvedLeave?: boolean;
    assignedStores?: ReadonlyArray<{
      id: string;
      latitude: string;
      longitude: string;
      radiusMeters: number;
      accuracyLimitMeters: number;
    }>;
    repeatedCoordinate?: boolean;
    selfieIntentAttached?: boolean;
  } = {},
) {
  const row = {
    id: '00000000-0000-4000-8000-000000000025',
    employeeId: EMPLOYEE_ID,
    deviceBindingId: BINDING_ID,
    type: data.type,
    idempotencyKey: IDEMPOTENCY_KEY,
    requestFingerprint: data.requestFingerprint,
    deviceIdHash: 'hash-from-approved-server-binding',
    receivedAt: options.receivedAt ?? receivedAt,
    processingStatus: 'RECEIVED',
    processingErrorCode: null as string | null,
    attendance: null as null | { id: string; validationStatus: AttendanceValidationStatus },
  };
  let createCount = 0;
  let createdAttendanceValidationStatus: AttendanceValidationStatus | null = null;
  const tx = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      if (query.sql.includes('FROM device_bindings')) {
        return [{ deviceIdHash: 'hash-from-approved-server-binding', fullName: 'Test Employee' }];
      }
      if (query.sql.includes('FROM employee_stores')) {
        return (
          options.assignedStores ?? [
            {
              id: STORE_ID,
              latitude: '-6.2',
              longitude: '106.8',
              radiusMeters: 10,
              accuracyLimitMeters: 30,
            },
          ]
        );
      }
      if (query.sql.includes('FROM shift_assignments AS sa')) {
        return (
          options.shiftAssignments ?? [
            {
              id: SHIFT_ASSIGNMENT_ID,
              storeId: STORE_ID,
              startTime: '09:00:00',
              endTime: '18:00:00',
              lateToleranceMinutes: 5,
              workDays: [7],
            },
          ]
        );
      }
      if (query.sql.includes('FROM holidays')) return [];
      if (query.sql.includes('FROM attendance_requests')) {
        return [{ approved: options.approvedLeave ?? false }];
      }
      if (query.sql.includes('FROM attendances AS a')) {
        const requestedDate = query.values.find(
          (value): value is string =>
            typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
        );
        return options.openCheckInsByDate?.[requestedDate ?? ''] ?? options.openCheckIns ?? [];
      }
      if (query.sql.includes('SELECT EXISTS') && query.sql.includes('FROM attendance_attempts')) {
        return [{ repeatedCoordinate: options.repeatedCoordinate ?? false }];
      }
      if (query.sql.includes('SELECT EXISTS') && query.sql.includes('FROM attendances')) {
        return [{ duplicate: options.duplicateCheckIn ?? false }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      void query;
      return 0;
    }),
    attendanceAttempt: {
      create: vi.fn(async (args: unknown) => {
        void args;
        createCount += 1;
        if (options.duplicateOnCreate && createCount > 1) throw uniqueConstraintError();
        return row;
      }),
      update: vi.fn(async ({ data: update }: { data: Record<string, unknown> }) => {
        row.processingStatus = update.processingStatus as typeof row.processingStatus;
        row.processingErrorCode = (update.processingErrorCode as string | null | undefined) ?? null;
        if (row.processingStatus === 'RECORDED') {
          row.attendance = {
            id: ATTENDANCE_ID,
            validationStatus:
              createdAttendanceValidationStatus ?? AttendanceValidationStatus.PENDING_VERIFICATION,
          };
        }
        return row;
      }),
      findUnique: vi.fn(async () => row),
    },
    selfieUploadIntent: {
      updateMany: vi.fn(async () => ({ count: options.selfieIntentAttached === false ? 0 : 1 })),
      findUnique: vi.fn(async () => ({
        objectKey: data.selfieSealedObjectKey,
        contentType: 'image/jpeg',
        status: 'ATTACHED',
        watermarkMetadata: { serverTime: row.receivedAt.toISOString() },
      })),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        void args;
        return {};
      }),
    },
    attendance: {
      create: vi.fn(
        async ({
          data: attendanceData,
        }: {
          data: { validationStatus: AttendanceValidationStatus };
        }) => {
          createdAttendanceValidationStatus = attendanceData.validationStatus;
          return { id: ATTENDANCE_ID, validationStatus: attendanceData.validationStatus };
        },
      ),
    },
    userAccount: {
      findMany: vi.fn(async () => [{ id: ADMIN_ACCOUNT_ID }]),
    },
    notification: {
      createMany: vi.fn(async (args: unknown) => {
        void args;
        return { count: 1 };
      }),
    },
    selfieCapture: { create: vi.fn(async () => ({})) },
    locationProof: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    async $transaction<T>(callback: (transaction: unknown) => Promise<T>) {
      return callback(tx);
    },
    attendanceAttempt: {
      findUnique: vi.fn(async () => (options.winnerExists === false ? null : row)),
    },
  };
  return {
    repository: new PrismaAttendanceAttemptRepository(prisma as never),
    tx,
    prisma,
  };
}

describe('PrismaAttendanceAttemptRepository', () => {
  it('re-reads the database unique-key winner after P2002 and does not audit a duplicate', async () => {
    const { repository, tx, prisma } = setup({ duplicateOnCreate: true });
    const created = await repository.createAttempt(data);
    const replay = await repository.createAttempt(data);

    expect(created).toMatchObject({
      created: true,
      record: {
        id: '00000000-0000-4000-8000-000000000025',
        processingStatus: 'RECORDED',
        attendanceId: ATTENDANCE_ID,
        attendanceValidationStatus: 'PENDING_VERIFICATION',
      },
    });
    expect(replay).toEqual({ record: created.record, created: false });
    expect(prisma.attendanceAttempt.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(
      tx.auditLog.create.mock.calls.map(
        ([call]) => (call as { data: { action: string } }).data.action,
      ),
    ).toEqual(['attendance.attempt.create', 'attendance.record.create']);
    expect(tx.attendanceAttempt.create).toBeDefined();
    expect(tx.notification.createMany).toHaveBeenCalledTimes(1);
  });

  it('creates one generic Admin verification event atomically for a newly recorded pending attendance', async () => {
    const { repository, tx } = setup();

    await repository.createAttempt(data);

    expect(tx.userAccount.findMany).toHaveBeenCalledWith({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          userAccountId: ADMIN_ACCOUNT_ID,
          kind: 'ATTENDANCE_VERIFICATION',
          title: 'Absensi menunggu verifikasi',
          message: 'Ada absensi yang menunggu verifikasi.',
          payload: { attendanceId: ATTENDANCE_ID },
        },
      ],
    });
    const event = JSON.stringify(vi.mocked(tx.notification.createMany).mock.calls[0]?.[0]);
    expect(event).not.toContain('latitude');
    expect(event).not.toContain('longitude');
    expect(event).not.toContain('selfie');
    expect(event).not.toContain('clientIp');
  });

  it('writes the attempt and minimal audit in one transaction using server-bound device hash', async () => {
    const { repository, tx } = setup();
    await repository.createAttempt(data);

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'attendance.attempt.create',
          afterData: {
            state: 'RECEIVED',
            type: 'CHECK_IN',
            networkStatus: 'ONLINE',
            reportedMethod: 'GPS',
          },
          deviceIdHash: 'hash-from-approved-server-binding',
        }),
      }),
    );
    expect(tx.selfieUploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        referenceHash: data.selfieReferenceHash,
        employeeId: EMPLOYEE_ID,
        deviceBindingId: BINDING_ID,
        objectKey: data.selfieStagedObjectKey,
        sealedObjectKey: data.selfieSealedObjectKey,
        status: 'PENDING',
        purgeClaimedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: {
        objectKey: data.selfieSealedObjectKey,
        sealedObjectKey: null,
        status: 'ATTACHED',
        attachedAttemptId: '00000000-0000-4000-8000-000000000025',
        retentionExpiresAt: data.selfieRetentionExpiresAt,
        watermarkMetadata: {
          employeeName: 'Test Employee',
          serverTime: receivedAt.toISOString(),
          latitude: data.latitude,
          longitude: data.longitude,
        },
      },
    });
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shiftAssignmentId: SHIFT_ASSIGNMENT_ID,
          sourceAttemptId: '00000000-0000-4000-8000-000000000025',
          validationStatus: 'PENDING_VERIFICATION',
          serverTime: receivedAt,
        }),
      }),
    );
    const reconciliation = vi.mocked(tx.$executeRaw).mock.calls[0]?.[0];
    expect(reconciliation?.sql).toContain('UPDATE daily_attendance_statuses');
    expect(reconciliation?.sql).toContain("AND status = 'ABSENT'");
    expect(reconciliation?.sql).toContain('corrected_by_attendance_correction_id IS NULL');
    expect(reconciliation?.sql).toContain("recap.status = 'CLOSED'");
    expect(reconciliation?.values).toContain('WAITING_VERIFICATION');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]!,
    );
    const auditCall = vi.mocked(tx.auditLog.create).mock.calls[0]?.[0];
    expect(JSON.stringify(auditCall)).not.toContain('-6.2');
    expect(JSON.stringify(auditCall)).not.toContain(data.selfieReferenceHash);
  });

  it('does not promote an in-tolerance offline attempt while liveness is unverified', async () => {
    const capturedAt = new Date(receivedAt.getTime() - 4 * 60 * 1000);
    const { repository, tx } = setup();

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt: capturedAt,
      networkStatus: NetworkStatus.OFFLINE,
      reportedMethod: ValidationMethod.GPS,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
          method: ValidationMethod.OFFLINE,
          networkStatus: NetworkStatus.OFFLINE,
          serverTime: receivedAt,
          deviceTime: capturedAt,
        }),
      }),
    );
    expect(tx.selfieCapture.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ capturedAt }) }),
    );
    expect(tx.locationProof.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: ValidationMethod.OFFLINE,
          capturedAt,
        }),
      }),
    );
    const reconciliation = vi.mocked(tx.$executeRaw).mock.calls[0]?.[0];
    expect(reconciliation?.values).toContain('WAITING_VERIFICATION');
  });

  it('reconciles a late same-WIB-day offline arrival using server workDate, not client time', async () => {
    const receivedAfterCutoff = new Date('2026-10-11T13:15:00.000Z');
    const clientRecordedAt = new Date('2026-10-11T10:00:00.000Z');
    const { repository, tx } = setup({ receivedAt: receivedAfterCutoff });

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt,
      networkStatus: NetworkStatus.OFFLINE,
      reportedMethod: ValidationMethod.GPS,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    const attendanceCall = vi.mocked(tx.attendance.create).mock.calls[0]?.[0];
    expect(attendanceCall?.data).toMatchObject({
      workDate: new Date('2026-10-11T00:00:00.000Z'),
      serverTime: receivedAfterCutoff,
      deviceTime: clientRecordedAt,
    });
    const reconciliation = vi.mocked(tx.$executeRaw).mock.calls[0]?.[0];
    expect(reconciliation?.values).toContain('2026-10-11');
    expect(reconciliation?.values).toContain(SHIFT_ASSIGNMENT_ID);
    expect(reconciliation?.values).toContain('WAITING_VERIFICATION');
    expect(reconciliation?.sql).toContain('AND shift_assignment_id =');
    expect(reconciliation?.sql).toContain('AND work_date =');
  });

  it.each([
    ['exactly five minutes behind', -5 * 60 * 1000],
    ['exactly five minutes ahead', 5 * 60 * 1000],
  ] as const)(
    'keeps an offline attempt %s within the time boundary without trusting client liveness',
    async (_label, offsetMs) => {
      const { repository, tx } = setup();
      const capturedAt = new Date(receivedAt.getTime() + offsetMs);

      const result = await repository.createAttempt({
        ...data,
        clientRecordedAt: capturedAt,
        networkStatus: NetworkStatus.OFFLINE,
        reportedMethod: ValidationMethod.GPS,
      });

      expect(result.record.attendanceValidationStatus).toBe(
        AttendanceValidationStatus.PENDING_VERIFICATION,
      );
      expect(vi.mocked(tx.attendance.create).mock.calls[0]?.[0]).toMatchObject({
        data: { serverTime: receivedAt, deviceTime: capturedAt },
      });
    },
  );

  it.each([
    ['more than five minutes behind', -(5 * 60 * 1000 + 1)],
    ['more than five minutes ahead', 5 * 60 * 1000 + 1],
  ] as const)(
    'requires verification when the offline device clock is %s',
    async (_label, offsetMs) => {
      const { repository, tx } = setup();

      const result = await repository.createAttempt({
        ...data,
        clientRecordedAt: new Date(receivedAt.getTime() + offsetMs),
        networkStatus: NetworkStatus.OFFLINE,
        reportedMethod: ValidationMethod.GPS,
      });

      expect(result.record.attendanceValidationStatus).toBe(
        AttendanceValidationStatus.PENDING_VERIFICATION,
      );
      expect(tx.attendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
            method: ValidationMethod.OFFLINE,
            networkStatus: NetworkStatus.OFFLINE,
          }),
        }),
      );
    },
  );

  it('keeps the exact 24-hour age boundary distinct while the drift rule still requires review', async () => {
    const { repository, tx } = setup();
    const capturedAt = new Date(receivedAt.getTime() - 24 * 60 * 60 * 1000);

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt: capturedAt,
      networkStatus: NetworkStatus.OFFLINE,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ serverTime: receivedAt, deviceTime: capturedAt }),
      }),
    );
  });

  it('requires verification when an offline attempt is more than 24 hours old', async () => {
    const { repository } = setup();

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt: new Date(receivedAt.getTime() - 24 * 60 * 60 * 1000 - 1),
      networkStatus: NetworkStatus.OFFLINE,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
  });

  it('keeps an offline GPS/geofence failure as a pending-verification attendance', async () => {
    const { repository, tx } = setup();

    const result = await repository.createAttempt({
      ...data,
      networkStatus: NetworkStatus.OFFLINE,
      reportedMethod: ValidationMethod.GPS,
      latitude: -6.21,
    });

    expect(result.record.processingStatus).toBe('RECORDED');
    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendanceAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ geofenceResult: 'OUTSIDE_RADIUS' }),
      }),
    );
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
          method: ValidationMethod.OFFLINE,
          networkStatus: NetworkStatus.OFFLINE,
        }),
      }),
    );
  });

  it.each([
    ['face was not detected', false, true],
    ['liveness failed', true, false],
    ['both client liveness claims pass but are not server-verified', true, true],
  ] as const)('keeps offline attendance pending when %s', async (_label, faceDetected, passed) => {
    const { repository, tx } = setup();

    const result = await repository.createAttempt({
      ...data,
      networkStatus: NetworkStatus.OFFLINE,
      livenessFaceDetectedClaim: faceDetected,
      livenessPassedClaim: passed,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.selfieCapture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ faceDetected: false, livenessPassed: false }),
      }),
    );
  });

  it('keeps a repeated-coordinate offline attempt pending even when the geofence passes', async () => {
    const { repository, tx } = setup({ repeatedCoordinate: true });

    const result = await repository.createAttempt({
      ...data,
      networkStatus: NetworkStatus.OFFLINE,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendanceAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          geofenceResult: 'WITHIN_LIMITS',
          repeatedCoordinate: true,
        }),
      }),
    );
  });

  it('does not auto-validate offline attempts relying on an unverified alternative method', async () => {
    const { repository, tx } = setup();

    const result = await repository.createAttempt({
      ...data,
      networkStatus: NetworkStatus.OFFLINE,
      reportedMethod: ValidationMethod.SUPERVISOR,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
          method: ValidationMethod.OFFLINE,
          networkStatus: NetworkStatus.OFFLINE,
        }),
      }),
    );
  });

  it('uses the server WIB date for a queue crossing midnight and preserves the device date', async () => {
    const serverReceipt = new Date('2026-10-11T17:02:00.000Z'); // Monday 00:02 WIB
    const deviceCapture = new Date('2026-10-11T16:58:00.000Z'); // Sunday 23:58 WIB
    const mondayShift = {
      id: SHIFT_ASSIGNMENT_ID,
      storeId: STORE_ID,
      startTime: '09:00:00',
      endTime: '18:00:00',
      lateToleranceMinutes: 5,
      workDays: [1],
    };
    const { repository, tx } = setup({
      receivedAt: serverReceipt,
      shiftAssignments: [mondayShift],
    });

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt: deviceCapture,
      networkStatus: NetworkStatus.OFFLINE,
    });

    expect(result.record.attendanceValidationStatus).toBe(
      AttendanceValidationStatus.PENDING_VERIFICATION,
    );
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workDate: new Date('2026-10-12T00:00:00.000Z'),
          serverTime: serverReceipt,
          deviceTime: deviceCapture,
        }),
      }),
    );
  });

  it('does not fall back to the device date shift when receipt date is non-working', async () => {
    const serverReceipt = new Date('2026-10-11T17:02:00.000Z'); // Monday 00:02 WIB
    const deviceCapture = new Date('2026-10-11T16:58:00.000Z'); // Sunday 23:58 WIB
    const sundayShift = {
      id: SHIFT_ASSIGNMENT_ID,
      storeId: STORE_ID,
      startTime: '22:00:00',
      endTime: '06:00:00',
      lateToleranceMinutes: 5,
      workDays: [7],
    };
    const { repository, tx } = setup({
      receivedAt: serverReceipt,
      shiftAssignments: [sundayShift],
    });

    const result = await repository.createAttempt({
      ...data,
      clientRecordedAt: deviceCapture,
      networkStatus: NetworkStatus.OFFLINE,
    });

    expect(result.record.processingStatus).toBe('RULE_REJECTED');
    expect(result.record.processingErrorCode).toBe('ATTENDANCE_NON_WORKING_DAY');
    expect(tx.attendanceAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientRecordedAt: deviceCapture }),
      }),
    );
    expect(tx.attendance.create).not.toHaveBeenCalled();
  });

  it('rejects the attempt if the selfie intent was already consumed or expired', async () => {
    const { repository, tx } = setup({ selfieIntentAttached: false });

    await expect(repository.createAttempt(data)).rejects.toMatchObject({
      statusCode: 422,
      code: 'ATTENDANCE_EVIDENCE_INVALID',
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('records a second check-in as rule-rejected when an active provisional check-in exists', async () => {
    const { repository, tx } = setup({ duplicateCheckIn: true });

    const result = await repository.createAttempt(data);

    expect(result.record.processingStatus).toBe('RULE_REJECTED');
    expect(result.record.processingErrorCode).toBe('ATTENDANCE_CHECK_IN_DUPLICATE');
    expect(tx.attendance.create).not.toHaveBeenCalled();
    expect(tx.attendanceAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          processingStatus: 'RULE_REJECTED',
          processingErrorCode: 'ATTENDANCE_CHECK_IN_DUPLICATE',
        },
      }),
    );
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'attendance.attempt.rule_rejected',
          entityType: 'attendance_attempt',
          afterData: { state: 'RULE_REJECTED', code: 'ATTENDANCE_CHECK_IN_DUPLICATE' },
        }),
      }),
    );
    const duplicateQuery = tx.$queryRaw.mock.calls
      .map(([query]) => (query as Prisma.Sql).sql)
      .find((sql) => sql.includes('FROM attendances') && sql.includes('SELECT EXISTS'));
    expect(duplicateQuery).toContain("validation_status <> 'REJECTED'");
  });

  it('attaches an overnight checkout to the previous work date through scheduled shift end', async () => {
    const overnightShift = {
      id: SHIFT_ASSIGNMENT_ID,
      storeId: STORE_ID,
      startTime: '22:00:00',
      endTime: '06:00:00',
      lateToleranceMinutes: 5,
      workDays: [7],
    };
    const previousDayCheckIn = {
      id: '00000000-0000-4000-8000-000000000030',
      shiftAssignmentId: SHIFT_ASSIGNMENT_ID,
      workDate: '2026-10-11',
      serverTime: new Date('2026-10-11T15:00:00.000Z'),
      validationStatus: 'PENDING_VERIFICATION' as const,
      recordStatus: 'ACTIVE' as const,
      storeId: STORE_ID,
    };
    const { repository, tx } = setup({
      receivedAt: new Date('2026-10-11T22:59:00.000Z'),
      shiftAssignments: [overnightShift],
      openCheckInsByDate: {
        '2026-10-11': [previousDayCheckIn],
        '2026-10-12': [],
      },
    });

    const result = await repository.createAttempt({ ...data, type: 'CHECK_OUT' });

    expect(result.record.processingStatus).toBe('RECORDED');
    expect(tx.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'CHECK_OUT',
          shiftAssignmentId: SHIFT_ASSIGNMENT_ID,
          workDate: new Date('2026-10-11T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('rejects overnight checkout after the scheduled end and preserves only the raw attempt', async () => {
    const overnightShift = {
      id: SHIFT_ASSIGNMENT_ID,
      storeId: STORE_ID,
      startTime: '22:00:00',
      endTime: '06:00:00',
      lateToleranceMinutes: 5,
      workDays: [7],
    };
    const previousDayCheckIn = {
      id: '00000000-0000-4000-8000-000000000030',
      shiftAssignmentId: SHIFT_ASSIGNMENT_ID,
      workDate: '2026-10-11',
      serverTime: new Date('2026-10-11T15:00:00.000Z'),
      validationStatus: 'PENDING_VERIFICATION' as const,
      recordStatus: 'ACTIVE' as const,
      storeId: STORE_ID,
    };
    const { repository, tx } = setup({
      receivedAt: new Date('2026-10-12T00:00:00.000Z'),
      shiftAssignments: [overnightShift],
      openCheckInsByDate: {
        '2026-10-11': [previousDayCheckIn],
        '2026-10-12': [],
      },
    });

    const result = await repository.createAttempt({ ...data, type: 'CHECK_OUT' });

    expect(result.record.processingStatus).toBe('RULE_REJECTED');
    expect(result.record.processingErrorCode).toBe('ATTENDANCE_CHECKOUT_WINDOW_EXPIRED');
    expect(tx.attendance.create).not.toHaveBeenCalled();
    expect(tx.attendanceAttempt.create).toHaveBeenCalledTimes(1);
  });

  it('persists the selected assigned store, distance/config snapshot, and repeated-coordinate flag', async () => {
    const { repository, tx } = setup({ repeatedCoordinate: true });
    await repository.createAttempt(data);

    expect(tx.attendanceAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          store: { connect: { id: STORE_ID } },
          distanceMeters: 0,
          geofenceRadiusMeters: 10,
          accuracyLimitMeters: 30,
          geofenceResult: 'WITHIN_LIMITS',
          repeatedCoordinate: true,
        }),
      }),
    );
  });

  it('does not attribute an unassigned client store hint and still keeps the raw attempt', async () => {
    const { repository, tx } = setup();
    await repository.createAttempt({
      ...data,
      storeIdHint: '00000000-0000-4000-8000-000000000027',
    });

    expect(tx.attendanceAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          distanceMeters: null,
          geofenceResult: 'STORE_NOT_ASSIGNED',
        }),
      }),
    );
    const attemptArguments = vi.mocked(tx.attendanceAttempt.create).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(attemptArguments?.data).not.toHaveProperty('store');
  });

  it('maps an unresolvable unique violation to a safe conflict code', async () => {
    const { repository } = setup({ duplicateOnCreate: true, winnerExists: false });
    await repository.createAttempt(data);

    await expect(repository.createAttempt(data)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ATTENDANCE_ATTEMPT_CONFLICT',
    } satisfies Partial<AppError>);
  });
});
