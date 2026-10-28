import { describe, expect, it, vi } from 'vitest';

import {
  AttendanceSubmissionError,
  prepareAttendanceAttempt,
  submitAttendanceAttempt,
  type AttendanceApiOptions,
  type PrepareAttendanceAttemptInput,
} from '../src/api/attendance-api.js';
import { toUserErrorMessage } from '../src/api/error-message.js';

const UUIDS = {
  reference: '00000000-0000-4000-8000-000000000002',
  key: '00000000-0000-4000-8000-000000000003',
  attempt: '00000000-0000-4000-8000-000000000004',
  attendance: '00000000-0000-4000-8000-000000000005',
} as const;

const uploadHeaders = {
  'Content-Type': 'image/jpeg',
  'x-amz-meta-referencehash': 'private-reference-hash',
} as const;

function uploadIntent(uploadUrl = 'https://storage.example/signed-upload') {
  return {
    referenceId: UUIDS.reference,
    uploadUrl,
    requiredHeaders: uploadHeaders,
    expiresAt: '2026-10-11T04:00:00.000Z',
  };
}

function receipt(replayed = false) {
  return {
    attemptId: UUIDS.attempt,
    state: 'RECORDED',
    type: 'CHECK_IN',
    receivedAt: '2026-10-11T03:00:00.000Z',
    replayed,
    attendanceId: UUIDS.attendance,
    validationStatus: 'PENDING_VERIFICATION',
  };
}

function locationFailureReceipt() {
  return {
    attemptId: UUIDS.attempt,
    state: 'RECEIVED',
    type: 'CHECK_IN',
    receivedAt: '2026-10-11T03:00:00.000Z',
    replayed: false,
    locationFailureReason: 'PERMISSION_DENIED',
  };
}

function input(
  overrides: Partial<PrepareAttendanceAttemptInput> = {},
): PrepareAttendanceAttemptInput {
  return {
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    photo: new Blob(['selfie-bytes'], { type: 'image/jpeg' }),
    location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    liveness: { faceDetected: false, passed: false },
    ...overrides,
  };
}

function response(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sequencedFetcher(responses: Response[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = vi.fn(async (request, init = {}) => {
    requests.push({ url: String(request), init });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return next;
  });
  return { fetcher, requests };
}

describe('employee online attendance API', () => {
  it('uploads the selfie and submits a no-fix attempt with an explicit failure reason', async () => {
    const { fetcher, requests } = sequencedFetcher([
      response(201, uploadIntent()),
      response(204),
      response(202, locationFailureReceipt()),
    ]);
    const options: AttendanceApiOptions = {
      apiBaseUrl: 'https://app.example/api/v1',
      fetcher,
      createIdempotencyKey: () => UUIDS.key,
    };

    const draft = await prepareAttendanceAttempt(
      input({ location: null, locationFailureReason: 'PERMISSION_DENIED' }),
      options,
    );
    const result = await submitAttendanceAttempt(draft, options);

    expect(draft.body.location).toBeNull();
    expect(draft.body.locationFailureReason).toBe('PERMISSION_DENIED');
    expect(JSON.parse(String(requests[2]?.init.body))).toMatchObject({
      location: null,
      locationFailureReason: 'PERMISSION_DENIED',
    });
    expect(result).toMatchObject({
      state: 'RECEIVED',
      locationFailureReason: 'PERMISSION_DENIED',
    });
    expect(result).not.toHaveProperty('attendanceId');
    expect(result).not.toHaveProperty('validationStatus');
  });

  it('requires a location failure reason only when there is no fix', async () => {
    const { fetcher, requests } = sequencedFetcher([]);

    await expect(
      prepareAttendanceAttempt(input({ location: null }), {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher,
        createIdempotencyKey: () => UUIDS.key,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_ATTEMPT' });

    await expect(
      prepareAttendanceAttempt(input({ locationFailureReason: 'TIMEOUT' }), {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher,
        createIdempotencyKey: () => UUIDS.key,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTENDANCE_ATTEMPT' });
    expect(requests).toHaveLength(0);
  });

  it('runs intent, signed PUT, then attempt with only the strict server contract', async () => {
    const { fetcher, requests } = sequencedFetcher([
      response(201, uploadIntent()),
      response(204),
      response(202, receipt()),
    ]);
    const options: AttendanceApiOptions = {
      apiBaseUrl: 'https://app.example/api/v1',
      fetcher,
      createIdempotencyKey: () => UUIDS.key,
    };

    const draft = await prepareAttendanceAttempt(input(), options);
    const result = await submitAttendanceAttempt(draft, options);

    expect(requests.map(({ init }) => init.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(requests[0]?.url).toBe('https://app.example/api/v1/attendance/selfie-upload-intents');
    expect(requests[0]?.init.credentials).toBe('include');
    expect(requests[0]?.init.cache).toBe('no-store');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      contentType: 'image/jpeg',
      sizeBytes: 12,
    });

    expect(requests[1]?.url).toBe('https://storage.example/signed-upload');
    expect(requests[1]?.init.credentials).toBe('omit');
    expect(requests[1]?.init.cache).toBe('no-store');
    expect(requests[1]?.init.headers).toEqual(uploadHeaders);
    expect(new Headers(requests[1]?.init.headers).has('authorization')).toBe(false);
    expect(requests[1]?.init.body).toBeInstanceOf(Blob);

    const body = JSON.parse(String(requests[2]?.init.body)) as Record<string, unknown>;
    expect(requests[2]?.url).toBe('https://app.example/api/v1/attendance/attempts');
    expect(requests[2]?.init.credentials).toBe('include');
    expect(requests[2]?.init.cache).toBe('no-store');
    expect(body).toEqual({
      idempotencyKey: UUIDS.key,
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
      networkStatus: 'ONLINE',
      location: { latitude: -6.200124, longitude: 106.800988, accuracyMeters: 12.35 },
      validationMethod: 'GPS',
      selfie: { blob: UUIDS.reference, sizeKb: 1 },
      liveness: { faceDetected: false, passed: false },
      proofCode: null,
    });
    for (const forbidden of [
      'storeId',
      'deviceId',
      'employeeId',
      'serverTime',
      'geofenceResult',
      'status',
      'validationStatus',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(result).toMatchObject({ state: 'RECORDED', attendanceId: UUIDS.attendance });
  });

  it('keeps all production attendance HTTP request bodies within 300 KiB at max selfie size', async () => {
    const { fetcher, requests } = sequencedFetcher([
      response(201, uploadIntent()),
      response(204),
      response(202, receipt()),
    ]);
    const options: AttendanceApiOptions = {
      apiBaseUrl: 'https://app.example/api/v1',
      fetcher,
      createIdempotencyKey: () => UUIDS.key,
    };

    const photo = new Blob([new Uint8Array(200 * 1024)], { type: 'image/jpeg' });
    const draft = await prepareAttendanceAttempt(input({ photo }), options);
    await submitAttendanceAttempt(draft, options);

    expect(requests.map(({ init }) => init.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(requests[1]?.init.body).toBe(photo);
    expect(requests[2]?.init.body).toBe(draft.serializedBody);

    const requestBodyBytes = requests.map(({ init }) => {
      if (typeof init.body === 'string') return new TextEncoder().encode(init.body).byteLength;
      if (init.body instanceof Blob) return init.body.size;
      throw new Error('Expected an attendance request string or Blob body.');
    });
    expect(requestBodyBytes[1]).toBe(200 * 1024);
    expect(requestBodyBytes.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(
      300 * 1024,
    );
  });

  it.each([
    'http://localhost:9000/signed',
    'http://127.0.0.1:9000/signed',
    'http://[::1]:9000/signed',
    'https://storage.example/signed',
  ])('accepts a signed upload URL on an allowed origin: %s', async (uploadUrl) => {
    const { fetcher, requests } = sequencedFetcher([
      response(201, uploadIntent(uploadUrl)),
      response(204),
    ]);
    await expect(
      prepareAttendanceAttempt(input(), {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher,
        createIdempotencyKey: () => UUIDS.key,
      }),
    ).resolves.toMatchObject({ body: { selfie: { blob: UUIDS.reference } } });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(new URL(uploadUrl).toString());
  });

  it.each(['http://storage.example/signed', 'http://localhost.example/signed'])(
    'rejects remote or non-loopback HTTP upload URLs: %s',
    async (uploadUrl) => {
      const { fetcher, requests } = sequencedFetcher([response(201, uploadIntent(uploadUrl))]);
      await expect(
        prepareAttendanceAttempt(input(), {
          apiBaseUrl: 'https://app.example/api/v1',
          fetcher,
          createIdempotencyKey: () => UUIDS.key,
        }),
      ).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
      expect(requests).toHaveLength(1);
    },
  );

  it('replays the identical serialized body and key after an unknown attempt response', async () => {
    const { fetcher, requests } = sequencedFetcher([
      response(201, uploadIntent()),
      response(204),
      response(202, receipt(false)),
      response(200, receipt(true)),
    ]);
    const draft = await prepareAttendanceAttempt(input(), {
      apiBaseUrl: 'https://app.example/api/v1',
      fetcher,
      createIdempotencyKey: () => UUIDS.key,
    });
    await submitAttendanceAttempt(draft, { apiBaseUrl: 'https://app.example/api/v1', fetcher });
    await submitAttendanceAttempt(draft, { apiBaseUrl: 'https://app.example/api/v1', fetcher });

    const attemptBodies = requests.slice(-2).map(({ init }) => String(init.body));
    expect(attemptBodies[0]).toBe(attemptBodies[1]);
    expect(JSON.parse(attemptBodies[0] ?? '{}').idempotencyKey).toBe(UUIDS.key);
  });

  it('rejects malformed intent/receipt and never treats an HTTP error as a receipt', async () => {
    const malformedIntent = sequencedFetcher([
      response(201, { ...uploadIntent(), referenceId: 'bad' }),
    ]);
    await expect(
      prepareAttendanceAttempt(input(), {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher: malformedIntent.fetcher,
      }),
    ).rejects.toBeInstanceOf(AttendanceSubmissionError);

    const badReceiptFetcher = sequencedFetcher([response(202, { ...receipt(), state: 'UNKNOWN' })]);
    const validDraft = {
      body: {
        idempotencyKey: UUIDS.key,
        type: 'CHECK_IN' as const,
        clientRecordedAt: '2026-10-11T10:00:00+07:00',
        networkStatus: 'ONLINE' as const,
        location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12 },
        validationMethod: 'GPS' as const,
        selfie: { blob: UUIDS.reference, sizeKb: 1 },
        liveness: { faceDetected: false, passed: false },
        proofCode: null,
      },
      serializedBody: JSON.stringify({ idempotencyKey: UUIDS.key, type: 'CHECK_IN' }),
    };
    await expect(
      submitAttendanceAttempt(validDraft, {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher: badReceiptFetcher.fetcher,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });

    const rejected = sequencedFetcher([
      response(409, { code: 'ATTENDANCE_STORE_SELECTION_REQUIRED' }),
    ]);
    await expect(
      submitAttendanceAttempt(validDraft, {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher: rejected.fetcher,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_STORE_SELECTION_REQUIRED' });
    expect(
      toUserErrorMessage(
        new AttendanceSubmissionError(409, 'ATTENDANCE_STORE_SELECTION_REQUIRED', 'attempt'),
      ),
    ).toContain('Toko absensi belum dapat ditentukan');
  });

  it('accepts OpenAPI RECEIVED receipts with optional attendance fields omitted', async () => {
    const received = {
      attemptId: UUIDS.attempt,
      state: 'RECEIVED',
      type: 'CHECK_IN',
      receivedAt: '2026-10-11T03:00:00.000Z',
      replayed: false,
    };
    const { fetcher } = sequencedFetcher([response(202, received)]);
    const draft = {
      body: {
        idempotencyKey: UUIDS.key,
        type: 'CHECK_IN' as const,
        clientRecordedAt: '2026-10-11T10:00:00+07:00',
        networkStatus: 'ONLINE' as const,
        location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12 },
        validationMethod: 'GPS' as const,
        selfie: { blob: UUIDS.reference, sizeKb: 1 },
        liveness: { faceDetected: false, passed: false },
        proofCode: null,
      },
      serializedBody: JSON.stringify({ idempotencyKey: UUIDS.key, type: 'CHECK_IN' }),
    };

    await expect(
      submitAttendanceAttempt(draft, { apiBaseUrl: 'https://app.example/api/v1', fetcher }),
    ).resolves.toEqual(received);
  });

  it.each([
    [400, 'INVALID_ATTENDANCE_ATTEMPT', 'Periksa kembali data percobaan absensi'],
    [401, 'UNAUTHENTICATED', 'Sesi Anda berakhir'],
    [403, 'ATTENDANCE_DEVICE_BINDING_REQUIRED', 'Perangkat terdaftar yang disetujui'],
    [409, 'ATTENDANCE_CHECK_IN_DUPLICATE', 'Absen masuk untuk shift ini sudah tercatat'],
    [422, 'ATTENDANCE_EVIDENCE_INVALID', 'Bukti absensi tidak valid'],
    [429, 'RATE_LIMITED', 'Terlalu banyak permintaan'],
    [
      503,
      'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
      'Validasi bukti absensi sedang tidak tersedia',
    ],
  ])('maps API %s %s to a safe Indonesian message', (status, code, expectedMessage) => {
    const safeMessage = toUserErrorMessage(new AttendanceSubmissionError(status, code, 'attempt'));
    expect(safeMessage).toContain(expectedMessage);
    expect(safeMessage).not.toContain('requestId');
    expect(safeMessage).not.toContain('detail');
  });
});
