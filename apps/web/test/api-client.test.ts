import { describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  apiFetch,
  getApiRecoveryAction,
  readApiErrorDetails,
  readApiJson,
} from '../src/api/api-client.js';
import { isApiCalendarDate, isApiDateTime, serializeApiDateTime } from '../src/api/api-contract.js';
import { toUserErrorMessage } from '../src/api/error-message.js';

describe('shared API transport', () => {
  it('defaults to cookie credentials and no-store while preserving same-origin headers and exact body', async () => {
    const body = '{"idempotencyKey":"same-body"}';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    });

    await apiFetch('/api/v1/attendance/attempts', { method: 'POST', headers, body }, { fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(init?.cache).toBe('no-store');
    expect(init?.headers).toBe(headers);
    expect(init?.body).toBe(body);
  });

  it('allows signed object storage uploads to explicitly omit credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const photo = new Blob(['private image']);
    const headers = { 'Content-Type': 'image/jpeg', 'x-amz-meta-referencehash': 'opaque' };

    await apiFetch(
      'https://storage.example/signed',
      { method: 'PUT', credentials: 'omit', headers, body: photo },
      { fetcher },
    );

    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.headers).toBe(headers);
    expect(init?.body).toBe(photo);
  });

  it('maps transport failures to a recoverable offline error and preserves aborts', async () => {
    const offline = await apiFetch(
      '/api/v1/me/dashboard',
      {},
      {
        fetcher: vi.fn<typeof fetch>(async () => {
          throw new TypeError('private low-level network diagnostic');
        }),
      },
    ).catch((error: unknown) => error);

    expect(offline).toBeInstanceOf(ApiClientError);
    expect(offline).toMatchObject({ status: 0, code: 'NETWORK_ERROR', recovery: 'retry' });
    expect(toUserErrorMessage(offline)).not.toContain('private low-level');

    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      apiFetch(
        '/api/v1/me/dashboard',
        {},
        {
          fetcher: vi.fn<typeof fetch>(async () => {
            throw abort;
          }),
        },
      ),
    ).rejects.toBe(abort);
  });
});

describe('HTTP error mapping and recovery', () => {
  it.each([
    [400, 'correct-input'],
    [401, 'sign-in'],
    [403, 'request-access'],
    [404, 'refresh'],
    [409, 'refresh'],
    [422, 'correct-input'],
    [429, 'wait'],
    [500, 'retry'],
    [503, 'retry'],
    [599, 'retry'],
  ] as const)('maps HTTP %s to a safe recovery action', async (status, recovery) => {
    const response = new Response(
      JSON.stringify({
        type: 'https://example.invalid/problem',
        title: 'sensitive server title',
        detail: 'sensitive server detail',
        code: 'UNKNOWN_TEST_CODE',
        requestId: 'req-safe-correlation-only',
      }),
      { status, headers: { 'Content-Type': 'application/problem+json' } },
    );

    await expect(readApiJson(response)).rejects.toMatchObject({ status, recovery });
    const errorResponse = new Response(
      JSON.stringify({ title: 'sensitive server title', detail: 'sensitive server detail' }),
      { status },
    );
    const details = await readApiErrorDetails(errorResponse);
    expect(details).toEqual({ status });
    expect(JSON.stringify(details)).not.toContain('sensitive');
    expect(
      toUserErrorMessage({
        status,
        code: 'UNKNOWN_TEST_CODE',
        title: 'sensitive server title',
        detail: 'sensitive server detail',
      }),
    ).not.toContain('sensitive');
  });

  it('makes idempotency 409 explicitly recoverable only as a new attempt, never a blind replay', async () => {
    const response = new Response(
      JSON.stringify({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'server-only detail' }),
      { status: 409 },
    );
    const error = await readApiJson(response).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      recovery: 'new-attempt',
    });
    expect(getApiRecoveryAction({ status: 409, code: 'ATTENDANCE_ATTEMPT_CONFLICT' })).toBe(
      'refresh',
    );
    const message = toUserErrorMessage(error);
    expect(message).toContain('Jangan kirim ulang payload ini');
    expect(message).not.toContain('server-only detail');
  });

  it('does not retain unsafe Problem Details fields and maps malformed success JSON safely', async () => {
    const details = await readApiErrorDetails(
      new Response(
        JSON.stringify({ status: 500, title: 'private title', detail: 'private detail' }),
        { status: 500 },
      ),
    );
    expect(details).toEqual({ status: 500 });

    const safeDetails = await readApiErrorDetails(
      new Response(
        JSON.stringify({
          code: 'INVALID_INPUT',
          requestId: 'trace-123',
          title: 'private title',
          detail: 'private detail',
        }),
        { status: 400 },
      ),
    );
    expect(safeDetails).toEqual({ status: 400, code: 'INVALID_INPUT', requestId: 'trace-123' });

    await expect(readApiJson(new Response('{not-json', { status: 200 }))).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('accepts 204 without a body only when 204 is the declared success status', async () => {
    await expect(readApiJson(new Response(null, { status: 204 }), 204)).resolves.toBeUndefined();
    await expect(readApiJson(new Response(null, { status: 204 }), 200)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('OpenAPI enum date primitives', () => {
  it.each(['2026-10-11T03:00:00.000Z', '2026-10-11T10:00:00+07:00'])(
    'accepts timezone-aware date-time %s',
    (value) => {
      expect(isApiDateTime(value)).toBe(true);
    },
  );

  it.each([
    '2026-10-11T10:00:00',
    '2026-02-29T10:00:00Z',
    '2026-10-11T25:00:00Z',
    '2026-10-11T10:00:00+25:00',
  ])('rejects invalid or timezone-naive date-time %s', (value) => {
    expect(isApiDateTime(value)).toBe(false);
  });

  it('validates civil calendar dates without coercing timezone semantics', () => {
    expect(isApiCalendarDate('2024-02-29')).toBe(true);
    expect(isApiCalendarDate('2026-02-29')).toBe(false);
    expect(isApiCalendarDate('2026-10-11T00:00:00Z')).toBe(false);
  });

  it('serializes an instant as canonical UTC ISO date-time', () => {
    expect(serializeApiDateTime(new Date('2026-10-11T10:00:00+07:00'))).toBe(
      '2026-10-11T03:00:00.000Z',
    );
    expect(() => serializeApiDateTime(new Date(Number.NaN))).toThrow(RangeError);
  });
});
