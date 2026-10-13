import { describe, expect, it, vi } from 'vitest';

import {
  DeviceBindingStatus,
  RequestStatus,
  RequestType,
  UserRole,
} from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import {
  AttendanceRequestService,
  type AttendanceRequestRecord,
  type AttendanceRequestRepository,
} from '../../src/modules/attendance-requests/index.js';
import type { PrivateRequestAttachmentStorage } from '../../src/modules/attendance-requests/private-request-attachment-storage.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000101';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000102';
const REQUEST_ID = '00000000-0000-4000-8000-000000000103';
const NOW = new Date('2026-10-11T03:00:00.000Z');

function principal(role: UserRole = UserRole.EMPLOYEE): AuthPrincipal {
  return {
    userAccountId: ACCOUNT_ID,
    role,
    username: role.toLowerCase(),
    employeeId: role === UserRole.EMPLOYEE ? EMPLOYEE_ID : null,
    deviceBindingId: null,
    deviceBindingStatus: DeviceBindingStatus.APPROVED,
    mustChangePassword: false,
    consentRequired: false,
    sessionId: `request-session-${role}`,
    lastSeenAt: NOW,
  };
}

function record(overrides: Partial<AttendanceRequestRecord> = {}): AttendanceRequestRecord {
  return {
    id: REQUEST_ID,
    employeeId: EMPLOYEE_ID,
    employeeFullName: 'Karyawan Uji',
    requestType: RequestType.LEAVE,
    startDate: new Date('2026-10-12T00:00:00.000Z'),
    endDate: new Date('2026-10-13T00:00:00.000Z'),
    reason: 'Keperluan keluarga',
    attachmentObjectKey: null,
    requestedOvertimeMinutes: null,
    status: RequestStatus.PENDING,
    approverUserAccountId: null,
    approverRole: null,
    decisionAt: null,
    decisionNote: null,
    requestedAt: NOW,
    ...overrides,
  };
}

function harness() {
  const repository = {
    create: vi.fn(async (input: Parameters<AttendanceRequestRepository['create']>[0]) =>
      record({
        requestType: input.requestType,
        attachmentObjectKey: input.attachmentObjectKey,
        requestedOvertimeMinutes: input.requestedOvertimeMinutes,
      }),
    ),
    list: vi.fn(async () => ({ items: [], hasNextPage: false })),
    findAccessible: vi.fn(async (): Promise<AttendanceRequestRecord | null> => record()),
    decide: vi.fn(async (input: { decision: RequestStatus }) =>
      record({
        status: input.decision,
        requestedOvertimeMinutes: 90,
        requestType: RequestType.OVERTIME,
        approverRole: UserRole.ADMIN,
      }),
    ),
  } satisfies Pick<AttendanceRequestRepository, 'create' | 'list' | 'findAccessible' | 'decide'>;
  const attachments: PrivateRequestAttachmentStorage = {
    putDoctorNote: vi.fn(async () => undefined),
    createReadUrl: vi.fn(async () => 'https://private.example/signed-note'),
    deleteObject: vi.fn(async () => undefined),
  };
  const service = new AttendanceRequestService(repository, attachments, () => NOW);
  return { service, repository, attachments };
}

describe('AttendanceRequestService', () => {
  it('creates only the authenticated employee request and does not return the private object key', async () => {
    const { service, repository } = harness();
    const response = await service.create(
      principal(),
      {
        requestType: RequestType.LEAVE,
        startDate: '2026-10-12',
        endDate: '2026-10-13',
        reason: 'Keperluan keluarga',
      },
      { requestId: REQUEST_ID },
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ employeeId: EMPLOYEE_ID }) }),
    );
    expect(response).not.toHaveProperty('attachmentObjectKey');
    expect(response).toMatchObject({ status: RequestStatus.PENDING, approvedOvertimeMinutes: 0 });
  });

  it('rejects invalid dates and reversed ranges before repository or storage access', async () => {
    const { service, repository, attachments } = harness();
    const invalid = {
      requestType: RequestType.LEAVE,
      startDate: '2026-02-30',
      endDate: '2026-03-01',
      reason: 'Alasan',
    } as const;
    await expect(
      service.create(principal(), invalid, { requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: 'INVALID_ATTENDANCE_REQUEST',
    });
    await expect(
      service.create(
        principal(),
        { ...invalid, startDate: '2026-10-14', endDate: '2026-10-12' },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });
    expect(repository.create).not.toHaveBeenCalled();
    expect(attachments.putDoctorNote).not.toHaveBeenCalled();
  });

  it('rejects CORRECTION even if a caller bypasses route validation', async () => {
    const { service, repository } = harness();
    await expect(
      service.create(
        principal(),
        {
          requestType: RequestType.CORRECTION as never,
          startDate: '2026-10-12',
          endDate: '2026-10-12',
          reason: 'Koreksi absen',
        },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('requires positive integer overtime minutes and rejects the field on other types', async () => {
    const { service, repository } = harness();
    const base = { startDate: '2026-10-12', endDate: '2026-10-12', reason: 'Lembur tutup toko' };
    for (const requestedOvertimeMinutes of [0, -1, 1.5, Number.NaN]) {
      await expect(
        service.create(
          principal(),
          { ...base, requestType: RequestType.OVERTIME, requestedOvertimeMinutes },
          { requestId: REQUEST_ID },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });
    }
    await expect(
      service.create(
        principal(),
        { ...base, requestType: RequestType.LEAVE, requestedOvertimeMinutes: 60 },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('requires a signed-format doctor note for sick and uploads only signature-matched image bytes', async () => {
    const { service, repository, attachments } = harness();
    const employeeWithNikUsername = { ...principal(), username: '3201010101010001' };
    const base = { startDate: '2026-10-12', endDate: '2026-10-12', reason: 'Sakit' };
    await expect(
      service.create(
        employeeWithNikUsername,
        { ...base, requestType: RequestType.SICK },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const created = await service.create(
      employeeWithNikUsername,
      {
        ...base,
        requestType: RequestType.SICK,
        doctorNote: { contentType: 'image/png', dataBase64: png.toString('base64') },
      },
      { requestId: REQUEST_ID },
    );
    expect(attachments.putDoctorNote).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png', bytes: png }),
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentObjectKey: expect.stringMatching(
          /^attendance-requests\/doctor-notes\/[0-9a-f-]{36}$/i,
        ),
      }),
    );
    const attachmentKey = repository.create.mock.calls[0]?.[0].attachmentObjectKey;
    expect(attachmentKey).not.toContain(employeeWithNikUsername.username);
    expect(attachmentKey).not.toContain(EMPLOYEE_ID);
    expect(attachmentKey).not.toContain(created.employee.fullName);
    expect(created.hasAttachment).toBe(true);
    expect(created).not.toHaveProperty('attachmentObjectKey');
    expect(created).not.toHaveProperty('doctorNote');
  });

  it('cleans up a separately stored note when request persistence fails', async () => {
    const { service, repository, attachments } = harness();
    vi.mocked(repository.create).mockRejectedValueOnce(
      new AppError(409, 'ATTENDANCE_REQUEST_DATE_OVERLAP', 'Overlap.'),
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      service.create(
        principal(),
        {
          requestType: RequestType.SICK,
          startDate: '2026-10-12',
          endDate: '2026-10-12',
          reason: 'Sakit',
          doctorNote: { contentType: 'image/png', dataBase64: png.toString('base64') },
        },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_REQUEST_DATE_OVERLAP' });
    expect(attachments.deleteObject).toHaveBeenCalledWith(
      expect.stringMatching(/^attendance-requests\/doctor-notes\//),
    );
  });

  it('issues private attachment URLs only after repository ownership/scope resolution', async () => {
    const { service, repository, attachments } = harness();
    vi.mocked(repository.findAccessible).mockResolvedValueOnce(
      record({ attachmentObjectKey: 'attendance-requests/doctor-notes/opaque-id' }),
    );
    const signed = await service.createAttachmentReadUrl(principal(), REQUEST_ID);
    expect(attachments.createReadUrl).toHaveBeenCalledWith({
      objectKey: 'attendance-requests/doctor-notes/opaque-id',
      expiresInSeconds: 120,
    });
    expect(signed.url).toContain('signed-note');

    vi.mocked(repository.findAccessible).mockResolvedValueOnce(null);
    await expect(service.createAttachmentReadUrl(principal(), REQUEST_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(attachments.createReadUrl).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a profileless employee detail and attachment read without signing a URL', async () => {
    const { service, repository, attachments } = harness();
    vi.mocked(repository.findAccessible).mockResolvedValue(null);
    const profilelessEmployee = { ...principal(), employeeId: null };

    await expect(service.detail(profilelessEmployee, REQUEST_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.createAttachmentReadUrl(profilelessEmployee, REQUEST_ID),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(attachments.createReadUrl).not.toHaveBeenCalled();
  });

  it('allows only Admin or Supervisor decisions and requires a non-empty decision note', async () => {
    const { service, repository } = harness();
    await expect(
      service.decide(
        principal(),
        REQUEST_ID,
        { decision: RequestStatus.APPROVED, decisionNote: 'Setuju' },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.decide(
        principal(UserRole.ADMIN),
        REQUEST_ID,
        { decision: RequestStatus.REJECTED, decisionNote: '   ' },
        { requestId: REQUEST_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_REQUEST' });
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('exposes approved overtime minutes only after approval', async () => {
    const { service, repository } = harness();
    const approved = await service.decide(
      principal(UserRole.ADMIN),
      REQUEST_ID,
      { decision: RequestStatus.APPROVED, decisionNote: 'Disetujui 90 menit.' },
      { requestId: REQUEST_ID },
    );
    expect(repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: RequestStatus.APPROVED }),
    );
    expect(approved.approvedOvertimeMinutes).toBe(90);
    expect((await service.detail(principal(), REQUEST_ID)).approvedOvertimeMinutes).toBe(0);
  });

  it('does not count a non-Admin approved overtime record if one is encountered', async () => {
    const { service, repository } = harness();
    vi.mocked(repository.findAccessible).mockResolvedValueOnce(
      record({
        requestType: RequestType.OVERTIME,
        requestedOvertimeMinutes: 45,
        status: RequestStatus.APPROVED,
        approverRole: UserRole.SUPERVISOR,
      }),
    );
    const dto = await service.detail(principal(), REQUEST_ID);
    expect(dto.status).toBe(RequestStatus.APPROVED);
    expect(dto.approvedOvertimeMinutes).toBe(0);
    expect(repository.decide).not.toHaveBeenCalled();
  });
});
