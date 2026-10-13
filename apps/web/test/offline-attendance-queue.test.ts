import { beforeEach, describe, expect, it } from 'vitest';

import type { AttendanceAttemptDraft, AttendanceReceipt } from '../src/api/attendance-api.js';
import {
  OfflineAttendanceQueue,
  OfflineQueueError,
  type OfflineQueueStorage,
} from '../src/components/attendance/offline-attendance-queue.js';

const EMPLOYEE_A = '00000000-0000-4000-8000-000000000011';
const EMPLOYEE_B = '00000000-0000-4000-8000-000000000012';
const PHOTO = new Blob(['private-selfie-fixture'], { type: 'image/jpeg' });

type StoredKey = Awaited<ReturnType<OfflineQueueStorage['readKeys']>>[number];
type StoredEntry = Awaited<ReturnType<OfflineQueueStorage['readEntries']>>[number];

class MemoryQueueStorage implements OfflineQueueStorage {
  readonly keys: StoredKey[] = [];
  readonly entries: StoredEntry[] = [];
  readonly leases = new Map<string, { entryId: string; token: string; expiresAt: number }>();
  failEntryWrite = false;

  async readKeys() {
    return [...this.keys];
  }

  async writeKey(record: StoredKey) {
    this.keys.push(record);
  }

  async readEntries() {
    return [...this.entries];
  }

  async writeEntry(record: StoredEntry) {
    if (this.failEntryWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    const index = this.entries.findIndex((entry) => entry.id === record.id);
    if (index === -1) this.entries.push(record);
    else this.entries[index] = record;
  }

  async acquireLease(entryId: string, token: string, now: number, ttlMs: number) {
    const active = this.leases.get(entryId);
    if (active && active.expiresAt > now) return false;
    this.leases.set(entryId, { entryId, token, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLease(entryId: string, token: string) {
    if (this.leases.get(entryId)?.token === token) this.leases.delete(entryId);
  }
}

function makeDraft(
  payload: Extract<
    Awaited<ReturnType<OfflineAttendanceQueue['list']>>[number]['payload'],
    { kind: 'pending' }
  >,
): AttendanceAttemptDraft {
  const body = {
    idempotencyKey: payload.idempotencyKey,
    type: payload.type,
    clientRecordedAt: payload.clientRecordedAt,
    networkStatus: 'OFFLINE' as const,
    location: payload.location,
    validationMethod: 'OFFLINE' as const,
    selfie: { blob: '00000000-0000-4000-8000-000000000014', sizeKb: 1 },
    liveness: { faceDetected: false, passed: false },
    proofCode: null,
  };
  return { body, serializedBody: JSON.stringify(body) };
}

function receipt(overrides: Partial<AttendanceReceipt> = {}): AttendanceReceipt {
  return {
    attemptId: '00000000-0000-4000-8000-000000000015',
    state: 'RECORDED',
    type: 'CHECK_IN',
    receivedAt: '2026-10-11T03:00:00.000Z',
    replayed: false,
    attendanceId: '00000000-0000-4000-8000-000000000016',
    validationStatus: 'PENDING_VERIFICATION',
    ...overrides,
  };
}

describe('encrypted offline attendance queue core', () => {
  let storage: MemoryQueueStorage;
  let queue: OfflineAttendanceQueue;

  beforeEach(() => {
    storage = new MemoryQueueStorage();
    queue = new OfflineAttendanceQueue(storage);
  });

  async function enqueue() {
    return queue.enqueue(EMPLOYEE_A, {
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
      photo: PHOTO,
      location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    });
  }

  it('encrypts queue content with a non-extractable per-owner AES-GCM key and a fresh IV on every update', async () => {
    const id = await enqueue();
    const before = storage.entries[0];
    expect(before).toBeDefined();
    expect(storage.keys[0]?.key.extractable).toBe(false);
    expect(storage.keys[0]?.key.algorithm.name).toBe('AES-GCM');
    expect(new Uint8Array(before?.iv ?? new ArrayBuffer(0))).toHaveLength(12);

    const opened = await queue.list(EMPLOYEE_A, true);
    expect(opened[0]).toMatchObject({
      id,
      payload: {
        networkStatus: 'OFFLINE',
        validationMethod: 'OFFLINE',
        liveness: { faceDetected: false, passed: false },
        location: { latitude: -6.200124, longitude: 106.800988, accuracyMeters: 12.35 },
      },
    });
    expect(await opened[0]?.photo?.text()).toBe(await PHOTO.text());

    expect((await queue.list(EMPLOYEE_A))[0]?.photo).toBeNull();

    const pendingPayload = opened[0]?.payload;
    if (!pendingPayload || pendingPayload.kind !== 'pending') {
      throw new Error('Expected pending queue payload');
    }
    const draft = makeDraft(pendingPayload);
    await queue.saveDraft(EMPLOYEE_A, id, draft);
    const after = storage.entries[0];
    expect(Array.from(new Uint8Array(after?.iv ?? new ArrayBuffer(0)))).not.toEqual(
      Array.from(new Uint8Array(before?.iv ?? new ArrayBuffer(0))),
    );
    const reopened = (await queue.list(EMPLOYEE_A))[0]?.payload;
    expect(reopened?.kind === 'pending' ? reopened.draft?.serializedBody : null).toBe(
      draft.serializedBody,
    );
  });

  it('isolates queue listings by the encrypted owner binding and survives queue-object reopen', async () => {
    const id = await enqueue();
    const reopened = new OfflineAttendanceQueue(storage);
    await expect(reopened.list(EMPLOYEE_B)).resolves.toEqual([]);
    await expect(reopened.list(EMPLOYEE_A)).resolves.toMatchObject([{ id }]);
  });

  it('writes no employee ID, photo, coordinate, timestamp, or request body as plaintext metadata', async () => {
    await enqueue();
    const serialized = JSON.stringify({ keys: storage.keys, entries: storage.entries });
    for (const secret of [
      EMPLOYEE_A,
      await PHOTO.text(),
      '-6.200124',
      '106.800988',
      '2026-10-11T10:00:00+07:00',
      'idempotencyKey',
      'networkStatus',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(storage.entries[0]).toMatchObject({ schemaVersion: 1, id: expect.any(String) });
    expect(storage.entries[0]).not.toHaveProperty('employeeId');
    expect(storage.entries[0]).not.toHaveProperty('photo');
  });

  it('replaces media and request data with a receipt-only encrypted tombstone after acknowledgment', async () => {
    const id = await enqueue();
    await expect(
      queue.acknowledge(EMPLOYEE_A, id, receipt({ type: 'CHECK_OUT' })),
    ).rejects.toMatchObject({ code: 'ACK_INVALID' });
    expect(storage.entries).toHaveLength(1);

    await queue.acknowledge(EMPLOYEE_A, id, receipt());
    expect(storage.entries).toHaveLength(1);
    expect(storage.keys).toHaveLength(1);
    const acknowledged = (await queue.list(EMPLOYEE_A))[0];
    expect(acknowledged?.photo).toBeNull();
    expect(acknowledged?.payload).toEqual({
      schemaVersion: 1,
      kind: 'receipt',
      receipt: receipt(),
    });
    expect(JSON.stringify(acknowledged?.payload)).not.toContain('location');
    expect(JSON.stringify(acknowledged?.payload)).not.toContain('photo');
    expect(JSON.stringify(acknowledged?.payload)).not.toContain('idempotencyKey');
  });

  it('fails closed on corrupted ciphertext without deleting the encrypted item', async () => {
    await enqueue();
    const record = storage.entries[0];
    if (!record) throw new Error('Expected encrypted record');
    const damaged = new Uint8Array(record.ciphertext.slice(0));
    damaged[0] = (damaged[0] ?? 0) ^ 0xff;
    storage.entries[0] = { ...record, ciphertext: damaged.buffer };

    await expect(queue.list(EMPLOYEE_A)).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(storage.entries).toHaveLength(1);
  });

  it('reports quota and unsupported crypto errors without claiming the capture was queued', async () => {
    storage.failEntryWrite = true;
    await expect(enqueue()).rejects.toMatchObject({ code: 'QUOTA' });
    expect(storage.entries).toHaveLength(0);

    const unavailable = new OfflineAttendanceQueue(storage, {} as Crypto);
    await expect(
      unavailable.enqueue(EMPLOYEE_A, {
        type: 'CHECK_IN',
        clientRecordedAt: '2026-10-11T10:00:00+07:00',
        photo: PHOTO,
        location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 10 },
      }),
    ).rejects.toBeInstanceOf(OfflineQueueError);
    await expect(
      unavailable.enqueue(EMPLOYEE_A, {
        type: 'CHECK_IN',
        clientRecordedAt: '2026-10-11T10:00:00+07:00',
        photo: PHOTO,
        location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 10 },
      }),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
  });

  it('serializes same-item foreground sync leases and only releases the owning token', async () => {
    const id = await enqueue();
    const token = await queue.acquireSyncLease(id);
    expect(token).toEqual(expect.any(String));
    await expect(queue.acquireSyncLease(id)).resolves.toBeNull();
    await queue.releaseSyncLease(id, 'other-token');
    await expect(queue.acquireSyncLease(id)).resolves.toBeNull();
    if (!token) throw new Error('Expected acquired lease');
    await queue.releaseSyncLease(id, token);
    await expect(queue.acquireSyncLease(id)).resolves.toEqual(expect.any(String));
  });
});
