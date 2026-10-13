import { describe, expect, it, vi } from 'vitest';

import { AttendanceValidationStatus, UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import {
  AttendanceVerificationService,
  type AttendanceVerificationRecord,
  type AttendanceVerificationRepository,
} from '../../src/modules/attendance/verification-workflow.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000101';
const SUPERVISOR_ID = '00000000-0000-4000-8000-000000000102';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000103';
const ATTENDANCE_ID = '00000000-0000-4000-8000-000000000104';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000105';
const STORE_ID = '00000000-0000-4000-8000-000000000106';
const SERVER_TIME = new Date('2026-10-10T02:00:00.000Z');
const DEVICE_TIME = new Date('2026-10-10T01:59:10.000Z');

function principal(role: UserRole, userAccountId?: string): AuthPrincipal {
  return {
    userAccountId:
      userAccountId ??
      (role === UserRole.ADMIN
        ? ADMIN_ID
        : role === UserRole.SUPERVISOR
          ? SUPERVISOR_ID
          : EMPLOYEE_ID),
    role,
    username: role.toLowerCase(),
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
    deviceBindingId: null,
    deviceBindingStatus: null,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: 'session-verification-test',
    lastSeenAt: SERVER_TIME,
  };
}

const record: AttendanceVerificationRecord = {
  attendanceId: ATTENDANCE_ID,
  employee: { id: EMPLOYEE_ID, fullName: 'Karyawan Uji', position: 'Kasir' },
  store: { id: STORE_ID, name: 'Toko Uji' },
  type: 'CHECK_IN',
  workDate: '2026-10-10',
  serverTime: SERVER_TIME,
  deviceTime: DEVICE_TIME,
  validationStatus: AttendanceValidationStatus.PENDING_VERIFICATION,
  method: 'GPS',
  networkStatus: 'ONLINE',
  sourceAttemptId: ATTEMPT_ID,
  deviceName: 'Android Uji',
  location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12.5, distanceMeters: 18.25 },
};

class MemoryVerificationRepository implements AttendanceVerificationRepository {
  readonly listPending = vi.fn(async () => ({ items: [record], hasNextPage: false }));
  readonly findPending = vi.fn(
    async (
      _input: Parameters<AttendanceVerificationRepository['findPending']>[0],
    ): Promise<AttendanceVerificationRecord | null> => {
      void _input;
      return record;
    },
  );
  readonly listHistory = vi.fn(async () => [
    {
      attendanceId: '00000000-0000-4000-8000-000000000107',
      type: 'CHECK_OUT',
      workDate: '2026-10-09',
      serverTime: '2026-10-09T10:00:00.000Z',
      deviceTime: null,
      validationStatus: 'APPROVED',
      reason: null,
      store: { id: STORE_ID, name: 'Toko Uji' },
    },
  ]);
  readonly decide = vi.fn(
    async (input: {
      attendanceId: string;
      decision: 'APPROVED' | 'REJECTED';
      reason: string | null;
      reviewedAt: Date;
    }) => ({
      attendanceId: input.attendanceId,
      validationStatus: input.decision,
      reviewedAt: input.reviewedAt,
      serverTime: SERVER_TIME,
      deviceTime: DEVICE_TIME,
    }),
  );
}

describe('AttendanceVerificationService', () => {
  it('returns scoped review evidence, recent history, and a computed 24-hour SLA indicator', async () => {
    const repository = new MemoryVerificationRepository();
    const selfieReader = {
      createReviewReadUrl: vi.fn(async () => ({
        url: 'https://private.example/signed?secret=temporary',
        expiresAt: '2026-10-10T02:02:00.000Z',
      })),
    };
    const service = new AttendanceVerificationService(
      repository,
      selfieReader,
      () => new Date('2026-10-11T02:00:00.000Z'),
    );

    const page = await service.listQueue(principal(UserRole.SUPERVISOR), {
      page: 1,
      pageSize: 25,
    });

    expect(page).toMatchObject({
      page: 1,
      pageSize: 25,
      items: [
        {
          attendanceId: ATTENDANCE_ID,
          employee: { fullName: 'Karyawan Uji' },
          store: { id: STORE_ID },
          serverTime: SERVER_TIME.toISOString(),
          deviceTime: DEVICE_TIME.toISOString(),
          dueAt: '2026-10-11T02:00:00.000Z',
          overdue: true,
          method: 'GPS',
          networkStatus: 'ONLINE',
          device: { name: 'Android Uji' },
          location: {
            latitude: -6.2,
            longitude: 106.8,
            accuracyMeters: 12.5,
            distanceMeters: 18.25,
          },
          selfie: { url: 'https://private.example/signed?secret=temporary' },
          recentAttendance: [{ attendanceId: '00000000-0000-4000-8000-000000000107' }],
        },
      ],
    });
    expect(repository.listPending).toHaveBeenCalledWith({
      actor: { role: UserRole.SUPERVISOR, userAccountId: SUPERVISOR_ID },
      skip: 0,
      take: 26,
    });
    expect(repository.listHistory).toHaveBeenCalledWith({
      actor: { role: UserRole.SUPERVISOR, userAccountId: SUPERVISOR_ID },
      employeeId: EMPLOYEE_ID,
      before: SERVER_TIME,
      excludeAttendanceId: ATTENDANCE_ID,
      take: 10,
    });
    expect(selfieReader.createReviewReadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ userAccountId: SUPERVISOR_ID, role: UserRole.SUPERVISOR }),
      ATTEMPT_ID,
    );
  });

  it('marks an item not overdue immediately before the SLA boundary', async () => {
    const service = new AttendanceVerificationService(
      new MemoryVerificationRepository(),
      {
        createReviewReadUrl: async () => ({
          url: 'private',
          expiresAt: '2026-10-10T02:02:00.000Z',
        }),
      },
      () => new Date('2026-10-11T01:59:59.999Z'),
    );

    await expect(
      service.getDetail(principal(UserRole.ADMIN), ATTENDANCE_ID),
    ).resolves.toMatchObject({
      dueAt: '2026-10-11T02:00:00.000Z',
      overdue: false,
      serverTime: SERVER_TIME.toISOString(),
      deviceTime: DEVICE_TIME.toISOString(),
    });
  });

  it('denies Employee access to queue, detail, selfie, and decision operations', async () => {
    const repository = new MemoryVerificationRepository();
    const service = new AttendanceVerificationService(repository, {
      createReviewReadUrl: async () => ({ url: 'private', expiresAt: '2026-10-10T02:02:00.000Z' }),
    });
    const employee = principal(UserRole.EMPLOYEE);

    await expect(service.listQueue(employee)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.getDetail(employee, ATTENDANCE_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.createSelfieReadUrl(employee, ATTENDANCE_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.decide(
        employee,
        ATTENDANCE_ID,
        { decision: 'APPROVED' },
        '00000000-0000-4000-8000-000000000108',
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.listPending).not.toHaveBeenCalled();
    expect(repository.findPending).not.toHaveBeenCalled();
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('requires a non-empty rejection reason and normalizes it before persistence', async () => {
    const repository = new MemoryVerificationRepository();
    const service = new AttendanceVerificationService(repository, {
      createReviewReadUrl: async () => ({ url: 'private', expiresAt: '2026-10-10T02:02:00.000Z' }),
    });
    const supervisor = principal(UserRole.SUPERVISOR);
    const requestId = '00000000-0000-4000-8000-000000000109';

    await expect(
      service.decide(supervisor, ATTENDANCE_ID, { decision: 'REJECTED', reason: '   ' }, requestId),
    ).rejects.toMatchObject({ statusCode: 400, code: 'REJECTION_REASON_REQUIRED' });
    expect(repository.decide).not.toHaveBeenCalled();

    await service.decide(
      supervisor,
      ATTENDANCE_ID,
      { decision: 'REJECTED', reason: '   Bukti tidak cocok.  ' },
      requestId,
    );
    expect(repository.decide).toHaveBeenCalledWith({
      actor: { role: UserRole.SUPERVISOR, userAccountId: SUPERVISOR_ID },
      attendanceId: ATTENDANCE_ID,
      decision: 'REJECTED',
      reason: 'Bukti tidak cocok.',
      reviewedAt: expect.any(Date),
      requestId,
    });
  });

  it('passes the original server and device timestamps through without changing them', async () => {
    const repository = new MemoryVerificationRepository();
    const service = new AttendanceVerificationService(
      repository,
      {
        createReviewReadUrl: async () => ({
          url: 'private',
          expiresAt: '2026-10-10T02:02:00.000Z',
        }),
      },
      () => new Date('2026-10-11T06:00:00.000Z'),
    );
    const result = await service.decide(
      principal(UserRole.ADMIN),
      ATTENDANCE_ID,
      { decision: 'APPROVED' },
      '00000000-0000-4000-8000-000000000110',
    );

    expect(result).toEqual({
      attendanceId: ATTENDANCE_ID,
      validationStatus: 'APPROVED',
      reviewedAt: '2026-10-11T06:00:00.000Z',
      serverTime: SERVER_TIME.toISOString(),
      deviceTime: DEVICE_TIME.toISOString(),
    });
    expect(repository.decide.mock.calls[0]?.[0]).not.toHaveProperty('serverTime');
    expect(repository.decide.mock.calls[0]?.[0]).not.toHaveProperty('deviceTime');
  });

  it('returns a scoped not-found result instead of leaking another store or null-store detail', async () => {
    const repository = new MemoryVerificationRepository();
    repository.findPending.mockResolvedValue(null);
    const service = new AttendanceVerificationService(repository, {
      createReviewReadUrl: async () => ({ url: 'private', expiresAt: '2026-10-10T02:02:00.000Z' }),
    });

    await expect(
      service.getDetail(principal(UserRole.SUPERVISOR), ATTENDANCE_ID),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'ATTENDANCE_VERIFICATION_NOT_FOUND',
    } satisfies Partial<AppError>);
    expect(repository.findPending).toHaveBeenCalledWith({
      actor: { role: UserRole.SUPERVISOR, userAccountId: SUPERVISOR_ID },
      attendanceId: ATTENDANCE_ID,
    });
  });
});
