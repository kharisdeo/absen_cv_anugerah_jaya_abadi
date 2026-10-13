import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IndexedDbQueueStorage,
  OFFLINE_QUEUE_DATABASE,
  OfflineAttendanceQueue,
  OfflineQueueError,
} from '../src/components/attendance/offline-attendance-queue.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000031';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000032';
const LEASE_ENTRY_ID = '00000000-0000-4000-8000-000000000033';
const CLIENT_RECORDED_AT = '2026-10-11T10:00:00+07:00';
const PHOTO_TEXT = 'private-image-bytes-fe-009a-fixture';
const PHOTO_BYTES = new TextEncoder().encode(PHOTO_TEXT);
const PHOTO = new Blob([PHOTO_TEXT], { type: 'image/jpeg' });

describe('IndexedDbQueueStorage persistence', () => {
  let factory: IDBFactory;
  let storages: IndexedDbQueueStorage[];

  beforeEach(() => {
    factory = new IDBFactory();
    storages = [];
  });

  afterEach(async () => {
    for (const storage of storages) storage.close();
    vi.restoreAllMocks();
    // Let each resolved open request run its close callback before deleting the database.
    await Promise.resolve();
    const request = factory.deleteDatabase(OFFLINE_QUEUE_DATABASE);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cleanup failed'));
      request.onblocked = () => reject(new Error('IndexedDB cleanup was blocked'));
    });
  });

  function createStorage(): IndexedDbQueueStorage {
    const storage = new IndexedDbQueueStorage(factory);
    storages.push(storage);
    return storage;
  }

  function createQueue(): OfflineAttendanceQueue {
    return new OfflineAttendanceQueue(createStorage());
  }

  it('serializes concurrent leases and only lets the owning token release one', async () => {
    const firstStorage = createStorage();
    const secondStorage = createStorage();
    const firstToken = 'lease-owner-one';
    const secondToken = 'lease-owner-two';

    const acquisitions = await Promise.all([
      firstStorage.acquireLease(LEASE_ENTRY_ID, firstToken, 10_000, 5_000),
      secondStorage.acquireLease(LEASE_ENTRY_ID, secondToken, 10_000, 5_000),
    ]);

    expect(acquisitions.filter(Boolean)).toHaveLength(1);
    const firstWon = acquisitions[0] === true;
    const ownerStorage = firstWon ? firstStorage : secondStorage;
    const ownerToken = firstWon ? firstToken : secondToken;
    const nonOwnerStorage = firstWon ? secondStorage : firstStorage;
    const nonOwnerToken = firstWon ? secondToken : firstToken;

    await nonOwnerStorage.releaseLease(LEASE_ENTRY_ID, nonOwnerToken);
    await expect(
      nonOwnerStorage.acquireLease(LEASE_ENTRY_ID, 'lease-non-owner-retry', 10_001, 5_000),
    ).resolves.toBe(false);

    await ownerStorage.releaseLease(LEASE_ENTRY_ID, ownerToken);
    await expect(
      nonOwnerStorage.acquireLease(LEASE_ENTRY_ID, 'lease-after-owner-release', 10_002, 5_000),
    ).resolves.toBe(true);
  });

  it('allows only one concurrent takeover at the exact lease expiry', async () => {
    const originalOwner = createStorage();
    const firstTakeover = createStorage();
    const secondTakeover = createStorage();

    await expect(
      originalOwner.acquireLease(LEASE_ENTRY_ID, 'lease-expiring', 1_000, 5_000),
    ).resolves.toBe(true);
    await expect(
      firstTakeover.acquireLease(LEASE_ENTRY_ID, 'lease-before-expiry', 5_999, 5_000),
    ).resolves.toBe(false);

    const takeovers = await Promise.all([
      firstTakeover.acquireLease(LEASE_ENTRY_ID, 'lease-takeover-one', 6_000, 5_000),
      secondTakeover.acquireLease(LEASE_ENTRY_ID, 'lease-takeover-two', 6_000, 5_000),
    ]);
    expect(takeovers.filter(Boolean)).toHaveLength(1);
  });

  it('maps a simulated entry-write quota error without persisting the capture', async () => {
    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError');
    const originalPut = IDBObjectStore.prototype.put;
    let entryWriteAttempts = 0;

    // This fault injection checks adapter error mapping; fake-indexeddb does not emulate device quota.
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'entries' && this.transaction.mode === 'readwrite') {
        entryWriteAttempts += 1;
        throw quotaError;
      }
      return originalPut.call(this, value, key);
    });

    const queue = createQueue();
    const enqueuePromise = queue.enqueue(EMPLOYEE_ID, {
      type: 'CHECK_IN',
      clientRecordedAt: CLIENT_RECORDED_AT,
      photo: PHOTO,
      location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    });
    await expect(enqueuePromise).rejects.toBeInstanceOf(OfflineQueueError);
    await expect(enqueuePromise).rejects.toMatchObject({ code: 'QUOTA' });

    expect(entryWriteAttempts).toBe(1);
    const inspector = createStorage();
    const storedKeys = await inspector.readKeys();
    const storedEntries = await inspector.readEntries();
    expect(storedKeys).toHaveLength(1);
    expect(storedEntries).toEqual([]);

    const serializedStorage = serializeStoredValue({ keys: storedKeys, entries: storedEntries });
    for (const plaintext of [
      EMPLOYEE_ID,
      CLIENT_RECORDED_AT,
      '-6.200124',
      '106.800988',
      '12.35',
      PHOTO_TEXT,
      Buffer.from(PHOTO_BYTES).toString('base64'),
    ]) {
      expect(serializedStorage).not.toContain(plaintext);
    }
  });

  it('keeps an encrypted pending capture owner-scoped and decryptable after close and reopen', async () => {
    const queue = createQueue();
    const entryId = await queue.enqueue(EMPLOYEE_ID, {
      type: 'CHECK_IN',
      clientRecordedAt: CLIENT_RECORDED_AT,
      photo: PHOTO,
      location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    });

    const inspector = createStorage();
    const storedKeys = await inspector.readKeys();
    const storedEntries = await inspector.readEntries();
    expect(storedKeys).toHaveLength(1);
    expect(storedEntries).toHaveLength(1);

    const storedKey = storedKeys[0];
    const storedEntry = storedEntries[0];
    expect(storedKey).toBeDefined();
    expect(storedKey?.key.extractable).toBe(false);
    expect(storedKey?.key.algorithm.name).toBe('AES-GCM');
    expect(storedKey?.key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
    expect(Object.keys(storedKey ?? {}).sort()).toEqual([
      'key',
      'keyRef',
      'ownerCiphertext',
      'ownerIv',
      'schemaVersion',
    ]);
    expect(storedEntry).toMatchObject({
      schemaVersion: 1,
      id: entryId,
      keyRef: storedKey?.keyRef,
      iv: expect.any(ArrayBuffer),
      ciphertext: expect.any(ArrayBuffer),
    });
    expect(storedEntry?.iv.byteLength).toBe(12);
    expect(storedEntry?.ciphertext.byteLength).toBeGreaterThan(16);
    expect(Object.keys(storedEntry ?? {}).sort()).toEqual([
      'ciphertext',
      'id',
      'iv',
      'keyRef',
      'schemaVersion',
    ]);

    const serializedStorage = serializeStoredValue({ keys: storedKeys, entries: storedEntries });
    for (const plaintext of [
      EMPLOYEE_ID,
      CLIENT_RECORDED_AT,
      '-6.200124',
      '106.800988',
      '12.35',
      PHOTO_TEXT,
      Buffer.from(PHOTO_BYTES).toString('base64'),
    ]) {
      expect(serializedStorage).not.toContain(plaintext);
    }
    expect(storedKey).not.toHaveProperty('employeeId');
    expect(storedKey).not.toHaveProperty('nik');
    expect(storedEntry).not.toHaveProperty('employeeId');
    expect(storedEntry).not.toHaveProperty('nik');

    const otherOwnerQueue = createQueue();
    await expect(otherOwnerQueue.list(OTHER_EMPLOYEE_ID, true)).resolves.toEqual([]);
    await expect(otherOwnerQueue.get(OTHER_EMPLOYEE_ID, entryId)).resolves.toBeNull();

    queue.close();
    otherOwnerQueue.close();
    inspector.close();
    // IndexedDbQueueStorage.close() is synchronous and schedules IDBDatabase.close().
    await Promise.resolve();

    const reopenedQueue = createQueue();
    expect(reopenedQueue).not.toBe(queue);
    const reopenedEntries = await reopenedQueue.list(EMPLOYEE_ID, true);
    expect(reopenedEntries).toHaveLength(1);
    const reopened = reopenedEntries[0];
    expect(reopened).toMatchObject({
      id: entryId,
      payload: {
        schemaVersion: 1,
        kind: 'pending',
        type: 'CHECK_IN',
        clientRecordedAt: CLIENT_RECORDED_AT,
        location: { latitude: -6.200124, longitude: 106.800988, accuracyMeters: 12.35 },
        photoType: 'image/jpeg',
        photoSizeBytes: PHOTO_BYTES.byteLength,
      },
    });
    const reopenedPhoto = reopened?.photo;
    expect(reopenedPhoto).toBeInstanceOf(Blob);
    if (!reopenedPhoto) throw new Error('Expected the reopened pending photo');
    expect(Array.from(new Uint8Array(await reopenedPhoto.arrayBuffer()))).toEqual(
      Array.from(PHOTO_BYTES),
    );
  });
});

function serializeStoredValue(value: unknown): string {
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${Buffer.from(value).toString('base64')})`;
  }
  if (ArrayBuffer.isView(value)) {
    return `ArrayBufferView(${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')})`;
  }
  if (value instanceof CryptoKey) {
    return `CryptoKey(${JSON.stringify({
      type: value.type,
      extractable: value.extractable,
      algorithm: value.algorithm,
      usages: value.usages,
    })})`;
  }
  if (Array.isArray(value)) return `[${value.map(serializeStoredValue).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeStoredValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
