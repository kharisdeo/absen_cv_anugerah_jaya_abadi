import { describe, expect, it, vi } from 'vitest';

import type { OfflineQueueStorage } from '../src/components/attendance/offline-attendance-queue.js';
import { OfflineAttendanceQueue } from '../src/components/attendance/offline-attendance-queue.js';
import {
  shouldSyncInForeground,
  syncOfflineAttendanceQueue,
} from '../src/components/attendance/offline-attendance-sync.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000021';
const UPLOAD_REFERENCE = '00000000-0000-4000-8000-000000000022';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000023';
const ATTENDANCE_ID = '00000000-0000-4000-8000-000000000024';
const UPLOAD_HEADERS = {
  'Content-Type': 'image/jpeg',
  'x-amz-meta-referencehash': 'signed-reference-hash',
};

type KeyRecord = Awaited<ReturnType<OfflineQueueStorage['readKeys']>>[number];
type EntryRecord = Awaited<ReturnType<OfflineQueueStorage['readEntries']>>[number];

class MemoryQueueStorage implements OfflineQueueStorage {
  readonly keys: KeyRecord[] = [];
  readonly entries: EntryRecord[] = [];
  readonly leases = new Map<string, { entryId: string; token: string; expiresAt: number }>();

  async readKeys() {
    return [...this.keys];
  }
  async writeKey(record: KeyRecord) {
    this.keys.push(record);
  }
  async readEntries() {
    return [...this.entries];
  }
  async writeEntry(record: EntryRecord) {
    const index = this.entries.findIndex((entry) => entry.id === record.id);
    if (index < 0) this.entries.push(record);
    else this.entries[index] = record;
  }
  async acquireLease(entryId: string, token: string, now: number, ttlMs: number) {
    const lease = this.leases.get(entryId);
    if (lease && lease.expiresAt > now) return false;
    this.leases.set(entryId, { entryId, token, expiresAt: now + ttlMs });
    return true;
  }
  async releaseLease(entryId: string, token: string) {
    if (this.leases.get(entryId)?.token === token) this.leases.delete(entryId);
  }
}

function response(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function intent() {
  return {
    referenceId: UPLOAD_REFERENCE,
    uploadUrl: 'https://storage.example/signed-upload',
    requiredHeaders: UPLOAD_HEADERS,
    expiresAt: '2026-10-11T04:00:00.000Z',
  };
}

function receipt(replayed = false) {
  return {
    attemptId: ATTEMPT_ID,
    state: 'RECORDED',
    type: 'CHECK_IN',
    receivedAt: '2026-10-11T03:00:00.000Z',
    replayed,
    attendanceId: ATTENDANCE_ID,
    validationStatus: 'PENDING_VERIFICATION',
  };
}

async function newQueue(storage = new MemoryQueueStorage()) {
  const queue = new OfflineAttendanceQueue(storage);
  const id = await queue.enqueue(EMPLOYEE_ID, {
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    photo: new Blob(['captured-camera-photo'], { type: 'image/jpeg' }),
    location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
  });
  return { queue, id, storage };
}

describe('offline attendance foreground sync', () => {
  it('uses serial intent → signed PUT without cookies → OFFLINE attempt and retains server receipt only', async () => {
    const { queue, id } = await newQueue();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = vi.fn(async (request, init = {}) => {
      requests.push({ url: String(request), init });
      if (requests.length === 1) return response(201, intent());
      if (requests.length === 2) return response(204);
      return response(202, receipt());
    });
    const verifyOwner = vi.fn(async () => true);

    const result = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher },
    });

    expect(result).toMatchObject({ stopped: false, error: null, acknowledged: [receipt()] });
    expect(requests.map(({ init }) => init.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(requests[0]?.url).toContain('/attendance/selfie-upload-intents');
    expect(requests[0]?.init.credentials).toBe('include');
    expect(requests[1]?.url).toBe('https://storage.example/signed-upload');
    expect(requests[1]?.init.credentials).toBe('omit');
    expect(requests[1]?.init.headers).toEqual(UPLOAD_HEADERS);
    expect(requests[1]?.init.body).toBeInstanceOf(Blob);
    expect(requests[2]?.url).toContain('/attendance/attempts');
    expect(requests[2]?.init.credentials).toBe('include');
    const attemptBody = JSON.parse(String(requests[2]?.init.body)) as Record<string, unknown>;
    expect(attemptBody).toMatchObject({
      networkStatus: 'OFFLINE',
      validationMethod: 'OFFLINE',
      liveness: { faceDetected: false, passed: false },
      proofCode: null,
      selfie: { blob: UPLOAD_REFERENCE, sizeKb: 1 },
    });
    expect(attemptBody).not.toHaveProperty('employeeId');
    expect(attemptBody).not.toHaveProperty('status');
    expect(verifyOwner).toHaveBeenCalledTimes(2);

    const persisted = (await queue.list(EMPLOYEE_ID)).find((entry) => entry.id === id);
    expect(persisted?.photo).toBeNull();
    expect(persisted?.payload.kind).toBe('receipt');
    expect(persisted?.payload.kind === 'receipt' ? persisted.payload.receipt : null).toEqual(
      receipt(),
    );
  });

  it('persists the frozen body before an ambiguous POST and replays that exact body after reopen', async () => {
    const { queue, id, storage } = await newQueue();
    const firstBodies: string[] = [];
    const firstFetcher: typeof fetch = vi.fn(async (_request, init = {}) => {
      if (init.method === 'POST' && String(_request).includes('selfie-upload-intents')) {
        return response(201, intent());
      }
      if (init.method === 'PUT') return response(204);
      firstBodies.push(String(init.body));
      throw new TypeError('connection ended after request dispatch');
    });

    const failed = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => true,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher: firstFetcher },
    });
    expect(failed.stopped).toBe(true);
    expect(failed.error).toMatchObject({ status: 0 });
    expect(firstBodies).toHaveLength(1);
    const saved = await queue.get(EMPLOYEE_ID, id);
    expect(saved?.payload.kind).toBe('pending');
    expect(saved?.payload.kind === 'pending' ? saved.payload.draft : null).not.toBeNull();
    expect(saved?.photo).not.toBeNull();

    const reopened = new OfflineAttendanceQueue(storage);
    const replayBodies: string[] = [];
    const replayFetcher: typeof fetch = vi.fn(async (_request, init = {}) => {
      replayBodies.push(String(init.body));
      return response(200, receipt(true));
    });
    const replayed = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue: reopened,
      verifyOwner: async () => true,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher: replayFetcher },
    });

    expect(replayed.acknowledged).toEqual([receipt(true)]);
    expect(replayBodies).toEqual(firstBodies);
    expect(replayBodies[0]).toContain('"networkStatus":"OFFLINE"');
    expect((await reopened.list(EMPLOYEE_ID)).find((entry) => entry.id === id)?.payload.kind).toBe(
      'receipt',
    );
  });

  it.each([401, 403, 429, 503])('retains the encrypted item after HTTP %s', async (status) => {
    const { queue, id } = await newQueue();
    const fetcher: typeof fetch = vi.fn(async () => response(status, { code: 'REQUEST_FAILED' }));
    const result = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => true,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher },
    });
    expect(result.stopped).toBe(true);
    expect((await queue.list(EMPLOYEE_ID)).find((entry) => entry.id === id)?.payload.kind).toBe(
      'pending',
    );
    expect((await queue.get(EMPLOYEE_ID, id))?.photo).not.toBeNull();
  });

  it('keeps an attempt after an API timeout and recovers after reopening the queue', async () => {
    const { queue, id, storage } = await newQueue();
    const timeoutFetcher: typeof fetch = vi.fn(
      (_request, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Request timed out', 'AbortError'));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        }),
    );

    const failed = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => true,
      isOnline: () => true,
      apiOptions: {
        apiBaseUrl: 'https://app.example/api/v1',
        fetcher: timeoutFetcher,
        timeoutMs: 5,
      },
    });

    expect(failed).toMatchObject({
      stopped: true,
      error: { status: 503, code: 'REQUEST_TIMEOUT' },
    });
    const reopened = new OfflineAttendanceQueue(storage);
    const retained = await reopened.get(EMPLOYEE_ID, id);
    expect(retained?.payload.kind).toBe('pending');
    expect(retained?.photo).not.toBeNull();

    const retryRequests: Array<{ url: string; method: string | undefined }> = [];
    const retryFetcher: typeof fetch = vi.fn(async (request, init = {}) => {
      const url = String(request);
      retryRequests.push({ url, method: init.method });
      if (url.includes('/attendance/selfie-upload-intents')) return response(201, intent());
      if (url === intent().uploadUrl) return response(204);
      if (url.includes('/attendance/attempts')) return response(202, receipt());
      throw new Error(`Unexpected request ${url}`);
    });
    const recovered = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue: reopened,
      verifyOwner: async () => true,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher: retryFetcher },
    });

    expect(recovered).toMatchObject({ stopped: false, acknowledged: [receipt()] });
    expect(retryRequests.filter(({ url }) => url.includes('/attendance/attempts'))).toHaveLength(1);
    expect((await reopened.get(EMPLOYEE_ID, id))?.payload.kind).toBe('receipt');
  });

  it('does not issue any API request when the current owner cannot be verified', async () => {
    const { queue } = await newQueue();
    const fetcher: typeof fetch = vi.fn();
    const result = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => false,
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher },
    });
    expect(result).toMatchObject({ stopped: true, acknowledged: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not start a network request while offline and keeps the queued capture', async () => {
    const { queue, id } = await newQueue();
    const fetcher: typeof fetch = vi.fn();

    const result = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => true,
      isOnline: () => false,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher },
    });

    expect(result).toMatchObject({ stopped: true, error: null, acknowledged: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await queue.get(EMPLOYEE_ID, id))?.payload.kind).toBe('pending');
    expect((await queue.get(EMPLOYEE_ID, id))?.photo).not.toBeNull();
  });

  it('revalidates after staging the selfie and does not dispatch attendance if the session expires', async () => {
    const { queue, id } = await newQueue();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = vi.fn(async (request, init = {}) => {
      requests.push({ url: String(request), init });
      if (requests.length === 1) return response(201, intent());
      if (requests.length === 2) return response(204);
      return response(202, receipt());
    });
    let ownerChecks = 0;
    const result = await syncOfflineAttendanceQueue({
      employeeId: EMPLOYEE_ID,
      queue,
      verifyOwner: async () => {
        ownerChecks += 1;
        return ownerChecks === 1;
      },
      isOnline: () => true,
      apiOptions: { apiBaseUrl: 'https://app.example/api/v1', fetcher },
    });

    expect(result).toMatchObject({ stopped: true, acknowledged: [] });
    expect(result.error).toBeNull();
    expect(ownerChecks).toBe(2);
    expect(requests.map(({ init }) => init.method)).toEqual(['POST', 'PUT']);
    expect(requests[0]?.url).toContain('/attendance/selfie-upload-intents');
    expect(requests[1]?.url).toBe('https://storage.example/signed-upload');
    expect(requests[1]?.init.body).toBeInstanceOf(Blob);
    expect(requests.some(({ url }) => url.includes('/attendance/attempts'))).toBe(false);
    expect(requests.map(({ init }) => String(init.body)).join('\n')).not.toContain('latitude');
    expect((await queue.get(EMPLOYEE_ID, id))?.photo).not.toBeNull();
  });

  it('falls back to app-open authenticated sync when Background Sync is unavailable', () => {
    expect(
      shouldSyncInForeground({
        online: true,
        authenticatedOwnerVerified: true,
        backgroundSyncSupported: false,
      }),
    ).toBe(true);
    expect(
      shouldSyncInForeground({
        online: true,
        authenticatedOwnerVerified: false,
        backgroundSyncSupported: false,
      }),
    ).toBe(false);
  });
});
