import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttendanceRequestsApiError,
  createAttendanceRequestsApi,
  type AttendanceRequestCreateInput,
} from '../src/api/attendance-requests-api.js';
import { toUserErrorMessage } from '../src/api/error-message.js';

const employeeId = '00000000-0000-4000-8000-000000000801';
const requestId = '00000000-0000-4000-8000-000000000802';
const requestDto = {
  id: requestId,
  employee: { id: employeeId, fullName: 'Karyawan Contoh' },
  requestType: 'SICK',
  startDate: '2026-10-12',
  endDate: '2026-10-12',
  reason: 'Tidak dapat masuk kerja',
  status: 'PENDING',
  requestedAt: '2026-10-11T04:00:00.000Z',
  decisionAt: null,
  decisionNote: null,
  hasAttachment: true,
  requestedOvertimeMinutes: null,
  approvedOvertimeMinutes: 0,
};

const fetchMock = vi.fn<typeof fetch>();
const api = createAttendanceRequestsApi({ apiBaseUrl: '/api/v1', fetcher: fetchMock });

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pngBase64(): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return btoa(String.fromCharCode(...bytes));
}

describe('employee attendance requests API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists the exact page DTO with server-owned personal scope and safe cache settings', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [requestDto], page: 2, pageSize: 25, hasNextPage: true }),
    );

    await expect(api.listRequests({ page: 2, pageSize: 25 })).resolves.toEqual({
      items: [requestDto],
      page: 2,
      pageSize: 25,
      hasNextPage: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/attendance/requests?page=2&pageSize=25',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('employeeId');
  });

  it('serializes only the strict allowed keys for each supported request type', async () => {
    const inputs: readonly AttendanceRequestCreateInput[] = [
      {
        requestType: 'LEAVE',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Keperluan keluarga',
      },
      {
        requestType: 'ANNUAL_LEAVE',
        startDate: '2026-10-13',
        endDate: '2026-10-14',
        reason: 'Cuti tahunan',
      },
      {
        requestType: 'OVERTIME',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        reason: 'Penyelesaian pekerjaan',
        requestedOvertimeMinutes: 90,
      },
      {
        requestType: 'SICK',
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        reason: 'Sakit dan berobat',
        doctorNote: { contentType: 'image/png', dataBase64: pngBase64() },
      },
    ];
    const expected = [
      {
        requestType: 'LEAVE',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Keperluan keluarga',
      },
      {
        requestType: 'ANNUAL_LEAVE',
        startDate: '2026-10-13',
        endDate: '2026-10-14',
        reason: 'Cuti tahunan',
      },
      {
        requestType: 'OVERTIME',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        reason: 'Penyelesaian pekerjaan',
        requestedOvertimeMinutes: 90,
      },
      {
        requestType: 'SICK',
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        reason: 'Sakit dan berobat',
        doctorNote: { contentType: 'image/png', dataBase64: pngBase64() },
      },
    ];

    expected.forEach(() => fetchMock.mockResolvedValueOnce(jsonResponse(requestDto, 201)));
    for (const input of inputs) await api.createRequest(input);

    const serialized = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(serialized).toEqual(expected);
    for (const body of serialized) {
      expect(body).not.toHaveProperty('employeeId');
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('approver');
      expect(body).not.toHaveProperty('storeId');
    }
    expect(Object.keys(serialized[0] as Record<string, unknown>).sort()).toEqual(
      ['endDate', 'reason', 'requestType', 'startDate'].sort(),
    );
    expect(Object.keys(serialized[2] as Record<string, unknown>).sort()).toEqual(
      ['endDate', 'reason', 'requestType', 'requestedOvertimeMinutes', 'startDate'].sort(),
    );
    expect(Object.keys(serialized[3] as Record<string, unknown>).sort()).toEqual(
      ['doctorNote', 'endDate', 'reason', 'requestType', 'startDate'].sort(),
    );
  });

  it('rejects extra or unsupported create fields before sending a request', async () => {
    const forged = {
      requestType: 'LEAVE',
      startDate: '2026-10-12',
      endDate: '2026-10-12',
      reason: 'Keperluan keluarga',
      employeeId,
      status: 'APPROVED',
      approver: 'Admin',
      storeId: '00000000-0000-4000-8000-000000000803',
    } as unknown as AttendanceRequestCreateInput;

    await expect(api.createRequest(forged)).rejects.toMatchObject({ status: 400 });
    await expect(
      api.createRequest({
        requestType: 'CORRECTION',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Koreksi',
      } as unknown as AttendanceRequestCreateInput),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid calendar ranges, reason, and oversized doctor note locally', async () => {
    await expect(
      api.createRequest({
        requestType: 'LEAVE',
        startDate: '2026-02-29',
        endDate: '2026-03-01',
        reason: 'Valid',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.createRequest({
        requestType: 'LEAVE',
        startDate: '2026-10-13',
        endDate: '2026-10-12',
        reason: 'Valid',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.createRequest({
        requestType: 'LEAVE',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: '   ',
      }),
    ).rejects.toMatchObject({ status: 400 });

    const oversizedBase64 = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) / 3) * 4);
    await expect(
      api.createRequest({
        requestType: 'SICK',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Sakit',
        doctorNote: { contentType: 'image/png', dataBase64: oversizedBase64 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed page/item DTOs and maps only safe API error codes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ ...requestDto, approverUserAccountId: 'private' }],
        page: 1,
        pageSize: 25,
        hasNextPage: false,
      }),
    );
    await expect(api.listRequests({ page: 1, pageSize: 25 })).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AttendanceRequestsApiError>);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'ATTENDANCE_REQUEST_DATE_OVERLAP', detail: 'raw private detail' }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );
    let error: unknown;
    try {
      await api.createRequest({
        requestType: 'LEAVE',
        startDate: '2026-10-12',
        endDate: '2026-10-12',
        reason: 'Izin',
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(toUserErrorMessage(error)).toContain('bertumpang tindih');
    expect(toUserErrorMessage(error)).not.toContain('raw private detail');
  });
});
