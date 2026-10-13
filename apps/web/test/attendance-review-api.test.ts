import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttendanceReviewApiError,
  createAttendanceReviewApi,
} from '../src/api/attendance-review-api.js';
import { toUserErrorMessage } from '../src/api/error-message.js';

const attendanceId = '00000000-0000-4000-8000-000000000901';
const employeeId = '00000000-0000-4000-8000-000000000902';
const requestId = '00000000-0000-4000-8000-000000000903';
const storeId = '00000000-0000-4000-8000-000000000904';
const signedSelfie = {
  url: 'https://private.example.test/photo?signature=temporary-secret',
  expiresAt: '2026-10-11T05:00:00.000Z',
};
const signedRequestAttachment = {
  url: 'https://private.example.test/doctor-note?signature=temporary-secret',
  expiresAt: '2026-10-11T05:02:00.000Z',
};
const verification = {
  attendanceId,
  employee: { id: employeeId, fullName: 'Karyawan Contoh', position: 'Kasir' },
  store: { id: storeId, name: 'Toko Utama' },
  type: 'CHECK_IN',
  workDate: '2026-10-11',
  serverTime: '2026-10-11T01:00:00.000Z',
  deviceTime: '2026-10-11T00:59:00.000Z',
  dueAt: '2026-10-12T01:00:00.000Z',
  overdue: false,
  validationStatus: 'PENDING_VERIFICATION',
  method: 'GPS',
  networkStatus: 'ONLINE',
  device: { name: 'Android' },
  location: {
    latitude: -6.2,
    longitude: 106.8,
    accuracyMeters: 12,
    distanceMeters: 5,
  },
  selfie: signedSelfie,
  recentAttendance: [
    {
      attendanceId: '00000000-0000-4000-8000-000000000905',
      type: 'CHECK_OUT',
      workDate: '2026-10-10',
      serverTime: '2026-10-10T10:00:00.000Z',
      deviceTime: null,
      validationStatus: 'VALID',
      reason: null,
      store: { id: storeId, name: 'Toko Utama' },
    },
  ],
};
const requestDto = {
  id: requestId,
  employee: { id: employeeId, fullName: 'Karyawan Contoh' },
  requestType: 'OVERTIME',
  startDate: '2026-10-11',
  endDate: '2026-10-11',
  reason: 'Penyelesaian pekerjaan',
  status: 'PENDING',
  requestedAt: '2026-10-11T00:00:00.000Z',
  decisionAt: null,
  decisionNote: null,
  hasAttachment: false,
  requestedOvertimeMinutes: 90,
  approvedOvertimeMinutes: 0,
};

const fetchMock = vi.fn<typeof fetch>();
const api = createAttendanceReviewApi({ apiBaseUrl: '/api/v1', fetcher: fetchMock });

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('attendance reviewer API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses server-derived verification scope and discards list signed URLs from memory', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [verification], page: 1, pageSize: 25, hasNextPage: false }),
    );

    const result = await api.listVerifications({ page: 1, pageSize: 25 });
    expect(result.items[0]?.selfie).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/attendance/verifications?page=1&pageSize=25',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('storeId');
    expect(url).not.toContain('employeeId');
  });

  it('loads scoped detail and short-lived selfie through exact paths without custom caching', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(verification));
    fetchMock.mockResolvedValueOnce(jsonResponse(signedSelfie));

    await expect(api.getVerificationDetail(attendanceId)).resolves.toMatchObject({
      attendanceId,
      selfie: signedSelfie,
      recentAttendance: [{ validationStatus: 'VALID' }],
    });
    await expect(api.getVerificationSelfieUrl(attendanceId)).resolves.toEqual(signedSelfie);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `/api/v1/attendance/verifications/${attendanceId}`,
      `/api/v1/attendance/verifications/${attendanceId}/selfie-url`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(true);
  });

  it('rejects insecure non-loopback selfie links and URLs containing embedded credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...verification,
        selfie: { ...signedSelfie, url: 'http://photos.example.test/a' },
      }),
    );
    await expect(api.getVerificationDetail(attendanceId)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...verification,
        selfie: { ...signedSelfie, url: 'https://reviewer:secret@private.example.test/photo' },
      }),
    );
    await expect(api.getVerificationDetail(attendanceId)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('sends only the strict verification decision fields and requires a rejection reason', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        attendanceId,
        validationStatus: 'APPROVED',
        reviewedAt: '2026-10-11T02:00:00.000Z',
        serverTime: verification.serverTime,
        deviceTime: verification.deviceTime,
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        attendanceId,
        validationStatus: 'REJECTED',
        reviewedAt: '2026-10-11T02:00:00.000Z',
        serverTime: verification.serverTime,
        deviceTime: verification.deviceTime,
      }),
    );

    await api.decideVerification(attendanceId, { decision: 'APPROVED' });
    await api.decideVerification(attendanceId, {
      decision: 'REJECTED',
      reason: 'Foto belum menunjukkan bukti yang cukup',
    });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { decision: 'APPROVED' },
      { decision: 'REJECTED', reason: 'Foto belum menunjukkan bukti yang cukup' },
    ]);

    await expect(
      api.decideVerification(attendanceId, { decision: 'REJECTED' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.decideVerification(attendanceId, {
        decision: 'REJECTED',
        reason: 'x'.repeat(501),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.decideVerification(attendanceId, {
        decision: 'REJECTED',
        reason: '😀'.repeat(251),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.decideVerification(attendanceId, {
        decision: 'APPROVED',
        storeId,
      } as unknown as { decision: 'APPROVED' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests only PENDING team reviews and never includes a browser-selected store', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [requestDto], page: 1, pageSize: 25, hasNextPage: true }),
    );

    await expect(api.listRequests({ page: 1, pageSize: 25 })).resolves.toMatchObject({
      items: [{ id: requestId, requestType: 'OVERTIME', status: 'PENDING' }],
      hasNextPage: true,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/v1/attendance/requests?status=PENDING&page=1&pageSize=25',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('storeId');
  });

  it('requests a doctor-note URL only through the exact endpoint with cookie and no-store', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse(signedRequestAttachment));

    await expect(api.getRequestAttachmentUrl(requestId, controller.signal)).resolves.toEqual(
      signedRequestAttachment,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/attendance/requests/${requestId}/attachment-url`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('strictly validates attachment DTO keys, timestamp, and signed URL scheme and credentials', async () => {
    for (const body of [
      { ...signedRequestAttachment, objectKey: 'private/object/key' },
      { ...signedRequestAttachment, url: 'http://files.example.test/doctor-note' },
      {
        ...signedRequestAttachment,
        url: 'https://reviewer:secret@private.example.test/doctor-note',
      },
      { ...signedRequestAttachment, url: 'not a URL' },
      { ...signedRequestAttachment, expiresAt: 'not-an-instant' },
      { url: signedRequestAttachment.url },
    ]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      await expect(api.getRequestAttachmentUrl(requestId)).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_RESPONSE',
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('allows only the existing loopback HTTP development exception and maps attachment errors safely', async () => {
    const loopbackAttachment = {
      ...signedRequestAttachment,
      url: 'http://localhost:4567/doctor-note?signature=temporary-secret',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(loopbackAttachment));
    await expect(api.getRequestAttachmentUrl(requestId)).resolves.toEqual(loopbackAttachment);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'REQUEST_ATTACHMENT_STORAGE_UNAVAILABLE',
          detail: 'https://private.example.test/doctor-note?signature=must-not-leak',
        },
        503,
      ),
    );
    let error: unknown;
    try {
      await api.getRequestAttachmentUrl(requestId);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(toUserErrorMessage(error)).toContain('Penyimpanan surat dokter');
    expect(toUserErrorMessage(error)).not.toContain('private.example.test');
    expect(toUserErrorMessage(error)).not.toContain('must-not-leak');
  });

  it('sends only decision and required decisionNote; rejects forged fields before fetch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...requestDto, status: 'APPROVED' }));

    await api.decideRequest(requestId, {
      decision: 'APPROVED',
      decisionNote: 'Disetujui sesuai kebutuhan operasional',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/attendance/requests/${requestId}/decision`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      decision: 'APPROVED',
      decisionNote: 'Disetujui sesuai kebutuhan operasional',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');

    await expect(
      api.decideRequest(requestId, { decision: 'REJECTED', decisionNote: '  ' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.decideRequest(requestId, {
        decision: 'REJECTED',
        decisionNote: 'x'.repeat(501),
        storeId,
      } as unknown as { decision: 'REJECTED'; decisionNote: string }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.decideRequest(requestId, {
        decision: 'REJECTED',
        decisionNote: '😀'.repeat(251),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected response properties and maps conflict/expired evidence safely', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...verification, selfie: null, clientIp: 'not-for-review' }],
        page: 1,
        pageSize: 25,
        hasNextPage: false,
      }),
    );
    await expect(api.listVerifications({ page: 1, pageSize: 25 })).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AttendanceReviewApiError>);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'ATTENDANCE_VERIFICATION_CONFLICT' }, 409),
    );
    await expect(
      api.decideVerification(attendanceId, { decision: 'APPROVED' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'ATTENDANCE_VERIFICATION_CONFLICT',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'SELFIE_NOT_FOUND' }, 404));
    let expiredError: unknown;
    try {
      await api.getVerificationSelfieUrl(attendanceId);
    } catch (error: unknown) {
      expiredError = error;
    }
    expect(toUserErrorMessage(expiredError)).toContain('kedaluwarsa');
    expect(toUserErrorMessage(expiredError)).not.toContain('signature=temporary-secret');
  });
});
